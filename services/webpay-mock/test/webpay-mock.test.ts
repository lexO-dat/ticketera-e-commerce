/** Webpay mock contra Redis real (TEST_REDIS_URL): API, formulario y regla por email. */
import { createLogger } from "@shared/commons";
import { type Redis, createRedis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "webpay-mock-test", level: "silent" });
const API = "/rswebpaytransaction/api/webpay/v1.2/transactions";
const auth = { "tbk-api-key-id": "597055555532", "tbk-api-key-secret": "secreto-de-prueba-123456" };

describe.skipIf(!REDIS_URL)("webpay-mock", () => {
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    redis = createRedis({ url: REDIS_URL!, connectionName: "webpay-mock-test", logger });
    app = buildApp({
      logger,
      redis,
      ttlSeconds: 600,
      options: {
        apiKeyId: auth["tbk-api-key-id"],
        apiKeySecret: auth["tbk-api-key-secret"],
        formUrl: "https://localhost:8443/webpay/form",
        defaultOutcome: "reject",
        latencyMs: 0,
        commitLossRatio: 0,
        errorRatio: 0,
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
  });

  async function create(email: string | null, amount = 77000) {
    const response = await app.inject({
      method: "POST",
      url: API,
      headers: { ...auth, ...(email ? { "x-mock-payer-email": email } : {}) },
      payload: {
        buy_order: `O-${Date.now()}`.slice(0, 26),
        session_id: "s1",
        amount,
        return_url: "https://localhost:8443/api/payments/return",
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { token: string; url: string };
  }

  const pay = (token: string, action: "pay" | "cancel" = "pay") =>
    app.inject({
      method: "POST",
      url: `/webpay/form/${action}`,
      payload: `token_ws=${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  const commit = (token: string) =>
    app.inject({ method: "PUT", url: `${API}/${token}`, headers: auth });

  it("exige las credenciales del API", async () => {
    const response = await app.inject({ method: "POST", url: API, payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("@acceptme.com: formulario → retorno con token_ws → commit AUTHORIZED, una sola vez", async () => {
    const { token, url } = await create("ana@acceptme.com");
    expect(url).toBe("https://localhost:8443/webpay/form");
    const form = await app.inject({ url: `/webpay/form?token_ws=${token}` });
    expect(form.statusCode).toBe(200);
    expect(form.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(form.body).toContain("$77.000");

    expect((await commit(token)).statusCode).toBe(422); // antes de pagar
    const back = await pay(token);
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe(
      `https://localhost:8443/api/payments/return?token_ws=${token}`,
    );

    const results = await Promise.all([commit(token), commit(token), commit(token)]);
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.json()).toMatchObject({
      status: "AUTHORIZED",
      response_code: 0,
      amount: 77000,
      card_detail: { card_number: "6623" },
    });
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(2);
    const status = await app.inject({ url: `${API}/${token}`, headers: auth });
    expect(status.json()).toMatchObject({ status: "AUTHORIZED", balance: 77000 });
    // El formulario ya no se puede reutilizar.
    expect((await app.inject({ url: `/webpay/form?token_ws=${token}` })).statusCode).toBe(410);
  });

  it("@rejectme.com rechaza; otro dominio rechaza con UNSUPPORTED_TEST_EMAIL", async () => {
    const rejected = await create("bo@rejectme.com");
    await pay(rejected.token);
    expect((await commit(rejected.token)).json()).toMatchObject({
      status: "FAILED",
      response_code: -1,
    });

    const other = await create("cami@gmail.com");
    await pay(other.token);
    expect((await commit(other.token)).json()).toMatchObject({
      status: "FAILED",
      mock_reason: "UNSUPPORTED_TEST_EMAIL",
    });
  });

  it("anular en el formulario vuelve con TBK_TOKEN y no se puede confirmar", async () => {
    const { token } = await create("ana@acceptme.com");
    const back = await pay(token, "cancel");
    const location = new URL(back.headers.location as string);
    expect(location.searchParams.get("TBK_TOKEN")).toBe(token);
    expect(location.searchParams.get("token_ws")).toBeNull();
    expect((await commit(token)).statusCode).toBe(422);
  });

  it("reembolso total el mismo día es reversa; parcial es anulación y respeta el saldo", async () => {
    const full = await create("ana@acceptme.com", 10000);
    await pay(full.token);
    await commit(full.token);
    const reversed = await app.inject({
      method: "POST",
      url: `${API}/${full.token}/refunds`,
      headers: auth,
      payload: { amount: 10000 },
    });
    expect(reversed.json()).toMatchObject({
      type: "REVERSED",
      balance: 0,
      nullified_amount: 10000,
    });

    const partial = await create("ana@acceptme.com", 10000);
    await pay(partial.token);
    await commit(partial.token);
    const refund = (amount: number) =>
      app.inject({
        method: "POST",
        url: `${API}/${partial.token}/refunds`,
        headers: auth,
        payload: { amount },
      });
    expect((await refund(4000)).json()).toMatchObject({ type: "NULLIFIED", balance: 6000 });
    expect((await refund(7000)).statusCode).toBe(422);
    expect((await refund(6000)).json()).toMatchObject({ balance: 0 });
  });
});
