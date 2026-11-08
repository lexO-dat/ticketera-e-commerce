/** Autenticación entre servicios, cliente HTTP con reintentos e idempotencia (Postgres real). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Pool,
  createPool,
  IDEMPOTENCY_SQL,
  requestHash,
  withIdempotency,
} from "../src/db/index.js";
import { createServer, createServiceClient, internalGuard } from "../src/http/index.js";
import { newId } from "../src/ids.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ service: "commons-test", level: "silent" });
const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("internalGuard", () => {
  it("solo deja pasar con el secreto compartido (404 si no)", async () => {
    const app = createServer({ logger });
    app.get("/internal/x", { preHandler: internalGuard("secreto-de-servicios") }, async () => ({
      ok: true,
    }));
    expect((await app.inject({ url: "/internal/x" })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: "/internal/x", headers: { "x-internal-token": "otro" } }))
        .statusCode,
    ).toBe(404);
    const ok = await app.inject({
      url: "/internal/x",
      headers: { "x-internal-token": "secreto-de-servicios" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe("createServiceClient", () => {
  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reintenta 5xx en operaciones idempotentes y propaga el 4xx como AppError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(200, { ok: 1 }));
    const client = createServiceClient({
      name: "x",
      baseUrl: "http://x",
      internalToken: "t",
      logger,
      fetchImpl,
    });
    expect((await client.request("GET", "/a")).body).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-internal-token"]).toBe("t");

    fetchImpl.mockResolvedValueOnce(
      response(409, { code: "CONFLICT", reason: "SEAT_TAKEN", detail: "tomada" }),
    );
    await expect(client.request("POST", "/b", { body: {} })).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "SEAT_TAKEN",
    });
  });

  it("no reintenta un POST sin clave de idempotencia y responde 503 si el servicio cae", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createServiceClient({ name: "pagos", baseUrl: "http://x", logger, fetchImpl });
    await expect(client.request("POST", "/c", { body: {} })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      client.request("POST", "/c", { body: {}, idempotencyKey: "k-123456789" }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe.skipIf(!DATABASE_URL)("withIdempotency", () => {
  let pool: Pool;
  const schema = `idem_${newId().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "commons-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ connectionString: url.toString(), applicationName: "commons-test" });
    await pool.query(IDEMPOTENCY_SQL);
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("solicitudes concurrentes con la misma clave ejecutan la operación una sola vez", async () => {
    let runs = 0;
    const key = newId();
    const hash = requestHash({ b: 2, a: 1 });
    expect(requestHash({ a: 1, b: 2 })).toBe(hash);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        withIdempotency(pool, { scope: "test", key, hash }, async () => {
          runs++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { statusCode: 201, body: { id: "x" } };
        }),
      ),
    );
    expect(runs).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(
      rejected.every((r) => (r.reason as { reason?: string }).reason === "IDEMPOTENCY_IN_PROGRESS"),
    ).toBe(true);

    const replay = await withIdempotency(pool, { scope: "test", key, hash }, async () => {
      runs++;
      return { statusCode: 500, body: { id: "otro" } };
    });
    expect(replay).toEqual({ statusCode: 201, body: { id: "x" }, replayed: true });
    expect(runs).toBe(1);

    await expect(
      withIdempotency(pool, { scope: "test", key, hash: requestHash({ a: 9 }) }, async () => ({
        statusCode: 201,
        body: {},
      })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 422 });
  });

  it("si la operación falla, la misma clave puede reintentarse", async () => {
    const key = newId();
    const hash = requestHash({ x: 1 });
    await expect(
      withIdempotency(pool, { scope: "test", key, hash }, async () => {
        throw new Error("adquirente caído");
      }),
    ).rejects.toThrow("adquirente caído");
    const retried = await withIdempotency(pool, { scope: "test", key, hash }, async () => ({
      statusCode: 200,
      body: { ok: true },
    }));
    expect(retried.replayed).toBe(false);
  });
});
