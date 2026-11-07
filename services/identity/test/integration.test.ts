/** Flujos completos contra Postgres real. Se activa con TEST_DATABASE_URL (ver README). */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLogger, newId } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import { createPool, runMigrations, type Pool } from "@shared/commons/db";
import type { FastifyInstance } from "fastify";
import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "../src/admin/service.js";
import { buildApp } from "../src/app.js";
import { KeyStore } from "../src/crypto/keys.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const logger = createLogger({ service: "identity-test", level: "silent" });
const config = {
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  PUBLIC_WEB_URL: "https://localhost:8443",
  LOGIN_MAX_FAILURES: 3,
  LOGIN_LOCK_MINUTES: 15,
};
const PASSWORD = "caballo correcto batería grapa";

describe.skipIf(!DATABASE_URL)("identity (integración)", () => {
  let pool: Pool;
  let keys: KeyStore;
  let app: FastifyInstance;
  const schema = `identity_${newId().replaceAll("-", "").slice(0, 12)}`;

  const post = (url: string, payload?: object, token?: string) =>
    app.inject({
      method: "POST",
      url,
      payload: payload ?? {},
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  async function register(email: string) {
    const response = await post("/v1/auth/register", {
      email,
      password: PASSWORD,
      fullName: "Ana Pérez",
    });
    expect(response.statusCode).toBe(202);
  }

  async function login(email: string, password = PASSWORD) {
    const response = await post("/v1/auth/login", { email, password });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { accessToken: string; refreshToken: string; user: { id: string } };
  }

  async function outboxData(type: string, email: string) {
    const { rows } = await pool.query(
      "select payload from outbox where type = $1 and payload->'data'->>'email' = $2 order by seq",
      [type, email],
    );
    return rows.map((row) => row.payload.data);
  }

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "identity-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ connectionString: url.toString(), applicationName: "identity-test" });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    keys = new KeyStore({
      pool,
      masterKey: randomBytes(32),
      maxAgeDays: 30,
      retiredGraceSeconds: 1800,
    });
    await keys.ensureActiveKey();
    app = buildApp({ logger, pool, keys, config });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("registro: no revela si el email existe y encola los eventos una sola vez", async () => {
    await register("Ana@Correo.cl ");
    await register("ana@correo.cl");
    expect(await outboxData("UsuarioRegistrado", "ana@correo.cl")).toHaveLength(1);
    const [verification] = await outboxData("VerificacionEmailSolicitada", "ana@correo.cl");
    expect(verification.verificationUrl).toMatch(
      /^https:\/\/localhost:8443\/verificar-email\?token=/,
    );

    const weak = await post("/v1/auth/register", {
      email: "b@correo.cl",
      password: "password123",
      fullName: "B",
    });
    expect(weak.statusCode).toBe(400);
  });

  it("login, /me y token verificable con el JWKS publicado", async () => {
    const session = await login("ANA@correo.cl");
    const me = await get("/v1/auth/me", session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email: "ana@correo.cl",
      roles: ["customer"],
      emailVerified: false,
    });
    expect(me.headers["cache-control"]).toBe("no-store");

    const jwks = (await get("/.well-known/jwks.json")).json();
    expect(jwks.keys[0]).not.toHaveProperty("d");
    const verify = createTokenVerifier({ getKey: localKeySet(jwks) });
    const user = await verify(session.accessToken);
    expect(user).toMatchObject({ id: session.user.id, roles: ["customer"] });
  });

  it("rechaza tokens firmados con otra clave, alterados o sin token", async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ roles: ["admin"], email_verified: true })
      .setProtectedHeader({ alg: "EdDSA", kid: "forjado" })
      .setIssuer("ticketera-identity")
      .setAudience("ticketera")
      .setSubject(newId())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect((await get("/v1/auth/me", forged)).statusCode).toBe(401);
    expect((await get("/v1/auth/me")).statusCode).toBe(401);
    const session = await login("ana@correo.cl");
    const [header, payload, signature] = session.accessToken.split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString());
    tampered.roles = ["admin"];
    const tamperedToken = [
      header,
      Buffer.from(JSON.stringify(tampered)).toString("base64url"),
      signature,
    ].join(".");
    expect((await get("/v1/auth/me", tamperedToken)).statusCode).toBe(401);
  });

  it("refresh rota el token; dos refresh simultáneos no matan la sesión", async () => {
    const session = await login("ana@correo.cl");
    const [first, second] = await Promise.all([
      post("/v1/auth/refresh", { refreshToken: session.refreshToken }),
      post("/v1/auth/refresh", { refreshToken: session.refreshToken }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 401]);
    const loser = first.statusCode === 401 ? first : second;
    expect(loser.json().reason).toBe("REFRESH_TOKEN_ROTATED");
    const winner = (first.statusCode === 200 ? first : second).json();
    expect(winner.refreshToken).not.toBe(session.refreshToken);
    const again = await post("/v1/auth/refresh", { refreshToken: winner.refreshToken });
    expect(again.statusCode).toBe(200);
  });

  it("reutilizar un refresh rotado (robo) revoca toda la sesión", async () => {
    const session = await login("ana@correo.cl");
    const rotated = (await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).json();
    // Fuera del margen de gracia.
    await pool.query(
      "update refresh_tokens set revoked_at = now() - interval '5 minutes' where id = $1",
      [session.refreshToken.split(".")[0]],
    );
    const reuse = await post("/v1/auth/refresh", { refreshToken: session.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().reason).toBe("REFRESH_TOKEN_REUSED");
    const legit = await post("/v1/auth/refresh", { refreshToken: rotated.refreshToken });
    expect(legit.statusCode).toBe(401);
  });

  it("logout revoca la sesión; refresh tokens mal formados dan 401", async () => {
    const session = await login("ana@correo.cl");
    expect((await post("/v1/auth/logout", { refreshToken: session.refreshToken })).statusCode).toBe(
      204,
    );
    expect(
      (await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).statusCode,
    ).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: "basura" })).statusCode).toBe(401);
    expect((await post("/v1/auth/logout", { refreshToken: "basura" })).statusCode).toBe(204);
  });

  it("bloquea la cuenta tras N fallos, incluso con la contraseña correcta", async () => {
    await register("lock@correo.cl");
    for (let i = 0; i < config.LOGIN_MAX_FAILURES; i++) {
      expect(
        (await post("/v1/auth/login", { email: "lock@correo.cl", password: "incorrecta-123" }))
          .statusCode,
      ).toBe(401);
    }
    const locked = await post("/v1/auth/login", { email: "lock@correo.cl", password: PASSWORD });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().reason).toBe("INVALID_CREDENTIALS");
    const unknown = await post("/v1/auth/login", { email: "nadie@correo.cl", password: PASSWORD });
    expect(unknown.json()).toEqual({ ...locked.json(), requestId: unknown.json().requestId });
  });

  it("verifica el email con un enlace de un solo uso", async () => {
    const [{ verificationUrl }] = await outboxData("VerificacionEmailSolicitada", "ana@correo.cl");
    const token = new URL(verificationUrl).searchParams.get("token");
    expect((await post("/v1/auth/email/verify", { token })).statusCode).toBe(204);
    expect((await post("/v1/auth/email/verify", { token })).statusCode).toBe(400);
    const session = await login("ana@correo.cl");
    expect((await get("/v1/auth/me", session.accessToken)).json().emailVerified).toBe(true);
  });

  it("recuperación de contraseña: respuesta genérica, enlace de un uso y cierre de sesiones", async () => {
    const before = await login("ana@correo.cl");
    expect((await post("/v1/auth/password/forgot", { email: "nadie@correo.cl" })).statusCode).toBe(
      202,
    );
    expect((await post("/v1/auth/password/forgot", { email: "ana@correo.cl" })).statusCode).toBe(
      202,
    );
    const [{ resetUrl }] = await outboxData("RecuperacionContrasenaSolicitada", "ana@correo.cl");
    const token = new URL(resetUrl).searchParams.get("token");
    const newPassword = "otra frase larga distinta";
    expect((await post("/v1/auth/password/reset", { token, newPassword })).statusCode).toBe(204);
    expect((await post("/v1/auth/password/reset", { token, newPassword })).statusCode).toBe(400);
    expect((await post("/v1/auth/refresh", { refreshToken: before.refreshToken })).statusCode).toBe(
      401,
    );
    expect(
      (await post("/v1/auth/login", { email: "ana@correo.cl", password: PASSWORD })).statusCode,
    ).toBe(401);
    await login("ana@correo.cl", newPassword);
  });

  it("cambio de contraseña conserva la sesión actual y cierra las demás", async () => {
    const current = await login("ana@correo.cl", "otra frase larga distinta");
    const other = await login("ana@correo.cl", "otra frase larga distinta");
    const wrong = await post(
      "/v1/auth/password/change",
      { currentPassword: "no-es", newPassword: PASSWORD },
      current.accessToken,
    );
    expect(wrong.statusCode).toBe(400);
    const changed = await post(
      "/v1/auth/password/change",
      { currentPassword: "otra frase larga distinta", newPassword: PASSWORD },
      current.accessToken,
    );
    expect(changed.statusCode).toBe(204);
    expect(
      (await post("/v1/auth/refresh", { refreshToken: current.refreshToken })).statusCode,
    ).toBe(200);
    expect((await post("/v1/auth/refresh", { refreshToken: other.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it("administración: solo admin, alta de equipo, roles y bloqueo protegiendo al último admin", async () => {
    const customer = await login("ana@correo.cl");
    expect((await get("/v1/admin/users", customer.accessToken)).statusCode).toBe(403);

    expect(await bootstrapAdmin(pool, "admin@ticketera.local", "admin-dev-password-123")).toBe(
      true,
    );
    expect(await bootstrapAdmin(pool, "otro@ticketera.local", "admin-dev-password-123")).toBe(
      false,
    );
    const admin = await login("admin@ticketera.local", "admin-dev-password-123");

    const created = await post(
      "/v1/admin/users",
      {
        email: "staff@ticketera.local",
        fullName: "Puerta 1",
        password: PASSWORD,
        roles: ["staff"],
      },
      admin.accessToken,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ roles: ["staff"], emailVerified: true });
    const duplicate = await post(
      "/v1/admin/users",
      { email: "staff@ticketera.local", fullName: "x", password: PASSWORD, roles: ["staff"] },
      admin.accessToken,
    );
    expect(duplicate.statusCode).toBe(409);

    const page1 = (await get("/v1/admin/users?limit=2", admin.accessToken)).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await get(`/v1/admin/users?limit=2&cursor=${page1.nextCursor}`, admin.accessToken)
    ).json();
    const ids = [...page1.items, ...page2.items].map((user: { id: string }) => user.id);
    expect(new Set(ids).size).toBe(ids.length);
    const search = (await get("/v1/admin/users?q=staff", admin.accessToken)).json();
    expect(search.items.map((user: { email: string }) => user.email)).toEqual([
      "staff@ticketera.local",
    ]);

    const selfDemote = await app.inject({
      method: "PUT",
      url: `/v1/admin/users/${admin.user.id}/roles`,
      payload: { roles: ["customer"] },
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(selfDemote.statusCode).toBe(403);
    expect(
      (await post(`/v1/admin/users/${admin.user.id}/disable`, {}, admin.accessToken)).statusCode,
    ).toBe(403);

    const staff = await login("staff@ticketera.local");
    const disabled = await post(`/v1/admin/users/${staff.user.id}/disable`, {}, admin.accessToken);
    expect(disabled.json().status).toBe("disabled");
    expect((await post("/v1/auth/refresh", { refreshToken: staff.refreshToken })).statusCode).toBe(
      401,
    );
    const blocked = await post("/v1/auth/login", {
      email: "staff@ticketera.local",
      password: PASSWORD,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().reason).toBe("ACCOUNT_DISABLED");
  });

  it("rota la clave de firma sin invalidar los tokens vigentes", async () => {
    const session = await login("ana@correo.cl");
    const before = (await get("/.well-known/jwks.json"))
      .json()
      .keys.map((key: { kid: string }) => key.kid);
    await pool.query("update signing_keys set created_at = now() - interval '60 days'");
    await keys.ensureActiveKey();
    const after = (await get("/.well-known/jwks.json"))
      .json()
      .keys.map((key: { kid: string }) => key.kid);
    expect(after).toHaveLength(2);
    expect(after).toEqual(expect.arrayContaining(before));
    expect((await get("/v1/auth/me", session.accessToken)).statusCode).toBe(200);
    const fresh = await login("ana@correo.cl");
    const kid = JSON.parse(
      Buffer.from(fresh.accessToken.split(".")[0]!, "base64url").toString(),
    ).kid;
    expect(before).not.toContain(kid);
  });
});
