/**
 * Prueba de contrato del adapter de Webpay contra el webpay-mock real (en proceso, con Redis):
 * la integración HTTP de verdad, no un doble. Se activa con TEST_REDIS_URL.
 */
import { createLogger } from "@shared/commons";
import { type Redis, createRedis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp as buildMock } from "../../webpay-mock/src/app.js";
import {
  type PaymentProvider,
  ProviderRejectedError,
  createWebpayProvider,
} from "../src/provider.js";

const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "payments-provider-test", level: "silent" });

describe.skipIf(!REDIS_URL)("adapter Webpay ↔ webpay-mock", () => {
  let redis: Redis;
  let mock: FastifyInstance;
  let provider: PaymentProvider;
  let baseUrl: string;

  beforeAll(async () => {
    redis = createRedis({ url: REDIS_URL!, connectionName: "payments-provider-test", logger });
    mock = buildMock({
      logger,
      redis,
      options: {
        apiKeyId: "597055555532",
        apiKeySecret: "secreto-de-prueba-123456",
        formUrl: "http://pago.test/webpay/form",
        defaultOutcome: "reject",
        latencyMs: 0,
        commitLossRatio: 0,
        errorRatio: 0,
      },
    });
    await mock.listen({ port: 0, host: "127.0.0.1" });
    const address = mock.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    provider = createWebpayProvider({
      baseUrl,
      apiKeyId: "597055555532",
      apiKeySecret: "secreto-de-prueba-123456",
      sendMockPayerEmail: true,
      logger,
    });
  });

  afterAll(async () => {
    await mock?.close();
    await redis?.quit();
  });

  const submit = (token: string) =>
    fetch(`${baseUrl}/webpay/form/pay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token_ws=${token}`,
      redirect: "manual",
    });

  it("create → formulario → commit → status → refund con los cuerpos reales de Webpay", async () => {
    const { token, url } = await provider.create({
      buyOrder: "TK-PRUEBA-0001",
      sessionId: "sesion",
      amount: 50000,
      returnUrl: "http://web.test/api/payments/return",
      payerEmail: "ana@acceptme.com",
    });
    expect(url).toBe("http://pago.test/webpay/form");
    await expect(provider.commit(token)).rejects.toBeInstanceOf(ProviderRejectedError); // aún no paga
    expect((await submit(token)).status).toBe(303);
    const committed = await provider.commit(token);
    expect(committed).toMatchObject({
      status: "AUTHORIZED",
      responseCode: 0,
      amount: 50000,
      buyOrder: "TK-PRUEBA-0001",
      cardLast4: "6623",
    });
    await expect(provider.commit(token)).rejects.toBeInstanceOf(ProviderRejectedError); // una sola vez
    expect((await provider.status(token)).status).toBe("AUTHORIZED");
    expect(await provider.refund(token, 20000)).toMatchObject({
      type: "NULLIFIED",
      balance: 30000,
    });
  });

  it("rechazo por email y motivo UNSUPPORTED_TEST_EMAIL", async () => {
    const other = await provider.create({
      buyOrder: "TK-PRUEBA-0002",
      sessionId: "s",
      amount: 1000,
      returnUrl: "http://web.test/r",
      payerEmail: "x@gmail.com",
    });
    await submit(other.token);
    expect(await provider.commit(other.token)).toMatchObject({
      status: "FAILED",
      reason: "UNSUPPORTED_TEST_EMAIL",
    });
  });
});
