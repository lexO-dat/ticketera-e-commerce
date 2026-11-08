import { createLogger } from "@shared/commons";
import { createAdmissionVerifier, createTokenVerifier, localKeySet } from "@shared/commons/auth";
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
  let queueKey: CryptoKey;
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
    const queuePair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    queueKey = queuePair.privateKey;
    const queueJwks = {
      keys: [{ ...(await exportJWK(queuePair.publicKey)), kid: "q1", alg: "EdDSA" }],
    };

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
      verifyAdmission: createAdmissionVerifier({ getKey: localKeySet(queueJwks) }),
      config: {
        IDENTITY_URLS: [`http://127.0.0.1:${port}`],
        CATALOG_URLS: [`http://127.0.0.1:${port}`],
        QUEUE_URLS: [`http://127.0.0.1:${port}`],
        INVENTORY_URLS: [`http://127.0.0.1:${port}`],
        ORDERS_URLS: [`http://127.0.0.1:${port}`],
        PAYMENTS_URLS: [`http://127.0.0.1:${port}`],
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

  it("enruta el catálogo público sin sesión y su administración solo con rol de gestión", async () => {
    const list = await gateway.inject({ url: "/catalog/events?sort=price" });
    expect(list.statusCode).toBe(200);
    expect(list.json().upstreamUrl).toBe("/v1/events?sort=price");

    expect((await gateway.inject({ url: "/catalog/admin/events" })).statusCode).toBe(401);
    const customer = await token(["customer"]);
    const denied = await gateway.inject({
      url: "/catalog/admin/events",
      headers: { authorization: `Bearer ${customer}` },
    });
    expect(denied.statusCode).toBe(403);
    for (const role of ["admin", "organizer", "seller"]) {
      const ok = await gateway.inject({
        url: "/catalog/admin/events",
        headers: { authorization: `Bearer ${await token([role])}` },
      });
      expect(ok.statusCode, role).toBe(200);
      expect(ok.json().upstreamUrl).toBe("/v1/admin/events");
    }
  });

  it("pre-verifica el turno de la fila: firma válida y del mismo usuario", async () => {
    const admission = (sub: string) =>
      new SignJWT({ evt: "e0000000-0000-0000-0000-000000000001" })
        .setProtectedHeader({ alg: "EdDSA", kid: "q1", typ: "admission+jwt" })
        .setIssuer("ticketera-queue")
        .setAudience("ticketera")
        .setSubject(sub)
        .setJti("j1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(queueKey);
    const authorization = `Bearer ${await token(["customer"])}`;
    const before = received.length;
    const foreign = await gateway.inject({
      method: "POST",
      url: "/inventory/reservations",
      payload: {},
      headers: { authorization, "x-admission-token": await admission("otro-usuario") },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().reason).toBe("ADMISSION_REQUIRED");
    const garbage = await gateway.inject({
      method: "POST",
      url: "/inventory/reservations",
      payload: {},
      headers: { authorization, "x-admission-token": "a.b.c" },
    });
    expect(garbage.statusCode).toBe(403);
    expect(received.length).toBe(before);

    const ok = await gateway.inject({
      method: "POST",
      url: "/inventory/reservations",
      payload: {},
      headers: {
        authorization,
        "x-admission-token": await admission("6f1c1a52-8a39-4f7c-9a55-3f2f0c1d2e3f"),
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().upstreamUrl).toBe("/v1/reservations");
    expect(received.at(-1)!.headers["x-admission-token"]).toBeDefined();
    const queueAdmin = await gateway.inject({
      url: "/queue/admin/events/x",
      headers: { authorization },
    });
    expect(queueAdmin.statusCode).toBe(403);
  });

  it("enruta orders y payments; el retorno del adquirente no exige sesión y /internal no es alcanzable", async () => {
    const back = await gateway.inject({ url: "/payments/return?token_ws=abc" });
    expect(back.statusCode).toBe(200);
    expect(back.json().upstreamUrl).toBe("/v1/return?token_ws=abc");
    const authorization = `Bearer ${await token(["customer"])}`;
    const cart = await gateway.inject({ url: "/orders/cart", headers: { authorization } });
    expect(cart.json().upstreamUrl).toBe("/v1/cart");
    expect(
      (await gateway.inject({ url: "/orders/admin/orders", headers: { authorization } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await gateway.inject({ url: "/payments/admin/ledger/check", headers: { authorization } }))
        .statusCode,
    ).toBe(403);
    const before = received.length;
    for (const url of [
      "/internal/orders/x",
      "/orders/../internal/orders/x",
      "/payments/%2e%2e/internal/payments",
    ]) {
      const response = await gateway.inject({ url, headers: { "x-internal-token": "adivinado" } });
      if (response.statusCode === 200)
        expect(response.json().upstreamUrl).not.toMatch(/^\/internal/);
    }
    expect(
      received
        .slice(before)
        .every(
          (r) => !r.url.startsWith("/internal") && r.headers["x-internal-token"] === undefined,
        ),
    ).toBe(true);
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
        CATALOG_URLS: ["http://127.0.0.1:1"],
        QUEUE_URLS: ["http://127.0.0.1:1"],
        INVENTORY_URLS: ["http://127.0.0.1:1"],
        ORDERS_URLS: ["http://127.0.0.1:1"],
        PAYMENTS_URLS: ["http://127.0.0.1:1"],
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
