import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { createServer, parseInput } from "../src/http/index.js";

const logger = createLogger({ service: "test", level: "silent" });

describe("createServer", () => {
  let app: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("responde live y ready, y propaga x-request-id", async () => {
    app = createServer({ logger, readinessChecks: { db: async () => undefined } });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { "x-request-id": "abc12345-req" },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ok", checks: { db: "ok" } });
    expect(ready.headers["x-request-id"]).toBe("abc12345-req");
  });

  it("ignora x-request-id mal formados", async () => {
    app = createServer({ logger });
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "<script>" },
    });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ready devuelve 503 si una dependencia falla o expira, o si se está apagando", async () => {
    app = createServer({
      logger,
      readinessTimeoutMs: 50,
      readinessChecks: {
        db: async () => undefined,
        redis: () => Promise.reject(new Error("ECONNREFUSED")),
        broker: () => new Promise(() => undefined),
      },
    });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { db: "ok", redis: "fail", broker: "fail" },
    });

    app.acceptingTraffic = false;
    const draining = await app.inject({ method: "GET", url: "/health/ready" });
    expect(draining.statusCode).toBe(503);
  });

  it("serializa errores como problem+json sin filtrar internos", async () => {
    app = createServer({ logger });
    app.post("/items", async (request) => {
      const body = parseInput(z.object({ quantity: z.number().int().positive() }), request.body);
      if (body.quantity > 4) throw AppError.conflict("LIMIT_EXCEEDED", "Máximo 4 por compra");
      return { ok: true };
    });
    app.get("/boom", async () => {
      throw new Error("connection string postgres://user:pass@db");
    });

    const invalid = await app.inject({ method: "POST", url: "/items", payload: { quantity: -1 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["content-type"]).toContain("application/problem+json");
    expect(invalid.json().issues[0].path).toBe("quantity");

    const conflict = await app.inject({ method: "POST", url: "/items", payload: { quantity: 5 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().reason).toBe("LIMIT_EXCEEDED");

    const malformed = await app.inject({
      method: "POST",
      url: "/items",
      payload: "{no-json",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.statusCode).toBe(400);

    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("postgres://");

    const missing = await app.inject({ method: "GET", url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("NOT_FOUND");
  });
});
