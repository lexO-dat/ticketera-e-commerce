import { createLogger } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import type { Redis } from "@shared/commons/redis";
import Fastify, { type FastifyInstance } from "fastify";
import { type CryptoKey, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const logger = createLogger({ service: "gateway-test", level: "silent" });

/** Redis en memoria con la semántica del script de ventana fija. */
function fakeRedis(): Redis {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  return {
    eval: async (_script: string, _keys: number, key: string, windowMs: number) => {
      const now = Date.now();
      const entry = counters.get(key);
      if (!entry || entry.expiresAt <= now) {
        counters.set(key, { count: 1, expiresAt: now + Number(windowMs) });
        return [1, Number(windowMs)];
      }
      entry.count++;
      return [entry.count, entry.expiresAt - now];
    },
  } as unknown as Redis;
}

describe("gateway", () => {
  let upstream: FastifyInstance;
  let gateway: FastifyInstance;
  let privateKey: CryptoKey;
  const received: { url: string; headers: Record<string, unknown> }[] = [];

  async function token(roles: string[], key: CryptoKey = privateKey) {
    return new SignJWT({ roles, email_verified: true })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer("ticketera-identity")
      .setAudience("ticketera")
      .setSubject("6f1c1a52-8a39-4f7c-9a55-3f2f0c1d2e3f")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    privateKey = pair.privateKey;
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };

    upstream = Fastify();
    upstream.all("/*", async (request) => {
      received.push({ url: request.url, headers: { ...request.headers } });
      return { upstreamUrl: request.url };
    });
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const address = upstream.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    gateway = await buildApp({
      logger,
      redis: fakeRedis(),
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
      config: {
        IDENTITY_URLS: [`http://127.0.0.1:${port}`],
        CORS_ORIGINS: ["https://localhost:8443"],
        TRUST_PROXY: ["127.0.0.1"],
        UPSTREAM_TIMEOUT_MS: 2_000,
        RATE_LIMIT_PER_MINUTE: 1_000,
      },
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it("enruta a identity reescribiendo el prefijo y propaga request-id e IP", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/auth/login?x=1",
      payload: { email: "a@b.cl", password: "x" },
      headers: {
        "x-request-id": "req-abcdef12",
        cookie: "session=secreto",
        "x-user-id": "suplantado",
        "x-forwarded-for": "203.0.113.7",
      },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().upstreamUrl).toBe("/v1/auth/login?x=1");
    const forwarded = received.at(-1)!.headers;
    expect(forwarded["x-request-id"]).toBe("req-abcdef12");
    expect(forwarded["x-forwarded-for"]).toBe("203.0.113.7");
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded["x-user-id"]).toBeUndefined();
  });

  it("rechaza tokens inválidos antes de llegar al servicio", async () => {
    const before = received.length;
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    for (const authorization of [
      "Bearer basura",
      `Bearer ${await token(["admin"], other.privateKey)}`,
      "Basic abc",
    ]) {
      const response = await gateway.inject({ url: "/auth/me", headers: { authorization } });
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    }
    expect(received.length).toBe(before);
  });

  it("exige rol admin en /admin/users", async () => {
    expect((await gateway.inject({ url: "/admin/users" })).statusCode).toBe(401);
    const customer = await token(["customer"]);
    expect(
      (
        await gateway.inject({
          url: "/admin/users",
          headers: { authorization: `Bearer ${customer}` },
        })
      ).statusCode,
    ).toBe(403);
    const admin = await token(["admin"]);
    const ok = await gateway.inject({
      url: "/admin/users?limit=5",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().upstreamUrl).toBe("/v1/admin/users?limit=5");
    // El token llega al servicio para que lo vuelva a verificar.
    expect(received.at(-1)!.headers.authorization).toBe(`Bearer ${admin}`);
  });

  it("no permite escapar del prefijo con ../", async () => {
    const response = await gateway.inject({ url: "/auth/../admin/users" });
    expect([400, 401, 404]).toContain(response.statusCode);
    expect(received.at(-1)!.url).not.toBe("/v1/admin/users");
  });

  it("limita los intentos de login por IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const response = await gateway.inject({
        method: "POST",
        url: "/auth/login",
        payload: {},
        remoteAddress: "198.51.100.20",
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) {
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        expect(response.json().reason).toBe("RATE_LIMIT_LOGIN");
      }
    }
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    // Otra IP no se ve afectada.
    const other = await gateway.inject({
      method: "POST",
      url: "/auth/login",
      payload: {},
      remoteAddress: "198.51.100.21",
    });
    expect(other.statusCode).toBe(200);
  });

  it("CORS solo para orígenes permitidos", async () => {
    const allowed = await gateway.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: { origin: "https://localhost:8443", "access-control-request-method": "POST" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://localhost:8443");
    const denied = await gateway.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("responde 503 problem+json si el servicio está caído", { timeout: 15_000 }, async () => {
    const down = await buildApp({
      logger,
      redis: fakeRedis(),
      verifyToken: async () => {
        throw new Error("no se usa");
      },
      config: {
        IDENTITY_URLS: ["http://127.0.0.1:1"],
        CORS_ORIGINS: [],
        TRUST_PROXY: [],
        UPSTREAM_TIMEOUT_MS: 1_000,
        RATE_LIMIT_PER_MINUTE: 1_000,
      },
    });
    // HTTP real: `inject` no modela bien un upstream que rechaza la conexión con cuerpo en vuelo.
    await down.listen({ port: 0, host: "127.0.0.1" });
    const address = down.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/auth/refresh`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(response.headers.get("retry-after")).toBe("5");
    await down.close();
  });
});
