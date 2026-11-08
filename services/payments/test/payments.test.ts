/**
 * Pagos contra Postgres real (TEST_DATABASE_URL) con un adquirente en memoria que se comporta como
 * Webpay (y como el mock por email). Cubre las pruebas obligatorias de docs/services/payments.md §10.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLogger, newId } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import { type Pool, createPool, runMigrations } from "@shared/commons/db";
import type { FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  type PaymentProvider,
  type ProviderTransaction,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "../src/provider.js";
import { type OrderForPayment, type PaymentService, createPaymentService } from "../src/service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const logger = createLogger({ service: "payments-test", level: "silent" });
const INTERNAL = "internal-test-token-0123456789abcdef";

interface FakeTx {
  amount: number;
  buyOrder: string;
  email: string;
  status: ProviderTransaction["status"];
  submitted: boolean;
  balance: number;
}

/** Adquirente falso con la semántica de Webpay: commit una vez, decide por email. */
function fakeProvider() {
  const txs = new Map<string, FakeTx>();
  const calls = { create: 0, commit: 0 };
  const flags = { loseNextCommit: false, failCreate: false, wrongAmount: false };
  const view = (tx: FakeTx): ProviderTransaction => ({
    status: tx.status,
    responseCode: tx.status === "AUTHORIZED" ? 0 : tx.status === "FAILED" ? -1 : null,
    amount: flags.wrongAmount ? tx.amount + 1 : tx.amount,
    buyOrder: tx.buyOrder,
    authorizationCode: tx.status === "AUTHORIZED" ? "123456" : null,
    cardLast4: "6623",
    paymentType: "VN",
    reason:
      tx.status === "FAILED" && !tx.email.endsWith("@rejectme.com")
        ? "UNSUPPORTED_TEST_EMAIL"
        : null,
  });
  const provider: PaymentProvider = {
    name: "webpay",
    async create(input) {
      calls.create++;
      if (flags.failCreate) throw new ProviderUnavailableError("caído");
      const token = randomUUID().replaceAll("-", "");
      txs.set(token, {
        amount: input.amount,
        buyOrder: input.buyOrder,
        email: input.payerEmail,
        status: "INITIALIZED",
        submitted: false,
        balance: 0,
      });
      return { token, url: "https://pago.test/webpay/form" };
    },
    async commit(token) {
      calls.commit++;
      const tx = txs.get(token)!;
      if (!tx.submitted || tx.status !== "INITIALIZED")
        throw new ProviderRejectedError(422, "invalid status");
      tx.status = tx.email.endsWith("@acceptme.com") ? "AUTHORIZED" : "FAILED";
      tx.balance = tx.status === "AUTHORIZED" ? tx.amount : 0;
      if (flags.loseNextCommit) {
        flags.loseNextCommit = false;
        throw new ProviderUnavailableError("respuesta perdida");
      }
      return view(tx);
    },
    async status(token) {
      return view(txs.get(token)!);
    },
    async refund(token, amount) {
      const tx = txs.get(token)!;
      tx.balance -= amount;
      return { type: tx.balance === 0 ? "REVERSED" : "NULLIFIED", balance: tx.balance };
    },
  };
  return {
    provider,
    txs,
    calls,
    flags,
    submit: (token: string) => (txs.get(token)!.submitted = true),
  };
}

describe.skipIf(!DATABASE_URL)("payments (integración)", () => {
  let pool: Pool;
  let payments: PaymentService;
  let app: FastifyInstance;
  let accessKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const fake = fakeProvider();
  const orders = new Map<string, OrderForPayment>();
  const schema = `payments_${newId().replaceAll("-", "").slice(0, 12)}`;
  const who = { actor: "test" };

  function order(
    email = "ana@acceptme.com",
    overrides: Partial<OrderForPayment> = {},
  ): OrderForPayment {
    const value: OrderForPayment = {
      id: newId(),
      orderCode: `TK${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      userId: newId(),
      status: "PENDING_PAYMENT",
      total: "77000",
      fees: "7000",
      buyerEmail: email,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    };
    orders.set(value.id, value);
    return value;
  }

  async function events(type: string, orderId: string) {
    const { rows } = await pool.query(
      "select payload from outbox where type = $1 and payload->'data'->>'orderId' = $2",
      [type, orderId],
    );
    return rows.map((row) => row.payload.data);
  }

  async function paidIntent(email = "ana@acceptme.com") {
    const o = order(email);
    const intent = await payments.createIntent(o.id, newId(), who);
    const token = new URL(intent.redirectUrl!).searchParams.get("token_ws")!;
    fake.submit(token);
    const result = await payments.handleReturn({ token_ws: token }, who);
    return { order: o, intent, token, result };
  }

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "payments-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({
      connectionString: url.toString(),
      applicationName: "payments-test",
      max: 20,
    });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    payments = createPaymentService({
      pool,
      logger,
      provider: fake.provider,
      orders: {
        getForPayment: async (id) => {
          const found = orders.get(id);
          if (!found) throw new Error("orden inexistente");
          return found;
        },
      },
      returnUrl: "https://localhost:8443/api/payments/return",
      maxAmount: 5_000_000n,
      maxFailedAttemptsPerOrder: 3,
      expiryGraceSeconds: 0,
    });
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    accessKey = pair.privateKey;
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };
    app = buildApp({
      logger,
      payments,
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
      internalToken: INTERNAL,
      webUrl: "https://localhost:8443",
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("doble envío concurrente con la misma clave: un intento y una transacción en el adquirente", async () => {
    const o = order();
    const before = fake.calls.create;
    const key = newId();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => payments.createIntent(o.id, key, who)),
    );
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      id: string;
    }>[];
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    expect(fake.calls.create - before).toBe(1);
    // Otra clave para la misma orden: devuelve el mismo intento vivo (sin segundo cobro).
    const again = await payments.createIntent(o.id, newId(), who);
    expect(again.id).toBe(ok[0]!.value.id);
    expect(again.redirectUrl).toContain("token_ws=");
    expect(fake.calls.create - before).toBe(1);
    const { rows } = await pool.query(
      "select count(*)::int as n from payment_intents where order_id = $1",
      [o.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("@acceptme.com: retorno repetido hace commit una sola vez, asienta el ledger y publica PagoAutorizado", async () => {
    const o = order();
    const intent = await payments.createIntent(o.id, newId(), who);
    const token = new URL(intent.redirectUrl!).searchParams.get("token_ws")!;
    fake.submit(token);
    const before = fake.calls.commit;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => payments.handleReturn({ token_ws: token }, who)),
    );
    expect(results.every((r) => r.outcome === "aprobado" && r.orderCode === o.orderCode)).toBe(
      true,
    );
    expect(fake.calls.commit - before).toBe(1);
    expect(await events("PagoAutorizado", o.id)).toHaveLength(1);
    const payment = await payments.get(intent.id);
    expect(payment).toMatchObject({
      status: "AUTHORIZED",
      cardLast4: "6623",
      authorizationCode: "123456",
    });
    const { rows } = await pool.query(
      "select account, amount::text from ledger_entries where intent_id = $1 order by account",
      [intent.id],
    );
    expect(rows).toEqual([
      { account: "customer_payments", amount: "-77000" },
      { account: "merchant_payable", amount: "70000" },
      { account: "platform_fees", amount: "7000" },
    ]);
  });

  it("@rejectme.com y otros dominios: FAILED y PagoRechazado", async () => {
    const rejected = await paidIntent("bo@rejectme.com");
    expect(rejected.result.outcome).toBe("rechazado");
    expect(await events("PagoRechazado", rejected.order.id)).toEqual([
      expect.objectContaining({ reason: "REJECTED" }),
    ]);
    const other = await paidIntent("cami@gmail.com");
    expect((await events("PagoRechazado", other.order.id))[0].reason).toBe(
      "UNSUPPORTED_TEST_EMAIL",
    );
  });

  it("commit sin respuesta → UNKNOWN → la conciliación lo resuelve con status", async () => {
    const o = order();
    const intent = await payments.createIntent(o.id, newId(), who);
    const token = new URL(intent.redirectUrl!).searchParams.get("token_ws")!;
    fake.submit(token);
    fake.flags.loseNextCommit = true;
    const result = await payments.handleReturn({ token_ws: token }, who);
    expect(result.outcome).toBe("pendiente");
    expect((await payments.get(intent.id))!.status).toBe("UNKNOWN");
    expect(await payments.reconcileUnknown()).toBeGreaterThanOrEqual(1);
    expect((await payments.get(intent.id))!.status).toBe("AUTHORIZED");
    expect(await events("PagoAutorizado", o.id)).toHaveLength(1);
  });

  it("anular en el formulario (TBK_TOKEN) → CANCELED; timeout (solo orden de compra) → EXPIRED", async () => {
    const canceled = order();
    const i1 = await payments.createIntent(canceled.id, newId(), who);
    const t1 = new URL(i1.redirectUrl!).searchParams.get("token_ws")!;
    expect(
      (await payments.handleReturn({ TBK_TOKEN: t1, TBK_ORDEN_COMPRA: i1.buyOrder }, who)).outcome,
    ).toBe("anulado");
    expect((await events("PagoRechazado", canceled.id))[0].reason).toBe("CANCELED");

    const timeout = order();
    const i2 = await payments.createIntent(timeout.id, newId(), who);
    expect(
      (await payments.handleReturn({ TBK_ORDEN_COMPRA: i2.buyOrder, TBK_ID_SESION: "x" }, who))
        .outcome,
    ).toBe("expirado");
    // Tras un intento fallido, la misma orden puede reintentar el pago (nuevo intento).
    const retry = await payments.createIntent(timeout.id, newId(), who);
    expect(retry.id).not.toBe(i2.id);
  });

  it("vencidos: sin pago → EXPIRED; pagado sin volver (pago tardío) → AUTHORIZED para que orders reembolse", async () => {
    const abandoned = order();
    const a = await payments.createIntent(abandoned.id, newId(), who);
    const late = order();
    const l = await payments.createIntent(late.id, newId(), who);
    const lateToken = new URL(l.redirectUrl!).searchParams.get("token_ws")!;
    fake.submit(lateToken);
    await fake.provider.commit(lateToken); // el adquirente lo autorizó, pero el navegador nunca volvió
    await pool.query(
      "update payment_intents set expires_at = now() - interval '1 minute' where id = any($1::uuid[])",
      [[a.id, l.id]],
    );
    await payments.expireStale();
    expect((await payments.get(a.id))!.status).toBe("EXPIRED");
    expect((await payments.get(l.id))!.status).toBe("AUTHORIZED");
    expect(await events("PagoAutorizado", late.id)).toHaveLength(1);
  });

  it("monto distinto del adquirente → FAILED con alerta (nunca se confirma)", async () => {
    fake.flags.wrongAmount = true;
    const { order: o, intent } = await paidIntent();
    fake.flags.wrongAmount = false;
    expect((await payments.get(intent.id))!).toMatchObject({
      status: "FAILED",
      failureReason: "AMOUNT_MISMATCH",
    });
    expect(await events("PagoAutorizado", o.id)).toHaveLength(0);
  });

  it("reembolsos parcial y total, idempotentes, con ledger balanceado", async () => {
    const { order: o, intent } = await paidIntent();
    const key = newId();
    const partial = await payments.refund(
      intent.id,
      { amount: 20000n, reason: "devolución parcial" },
      key,
      who,
    );
    expect(partial).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedAmount: "20000" });
    const replay = await payments.refund(
      intent.id,
      { amount: 20000n, reason: "devolución parcial" },
      key,
      who,
    );
    expect(replay.refundedAmount).toBe("20000");
    await expect(
      payments.refund(intent.id, { amount: 99999n, reason: "demasiado" }, newId(), who),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const rest = await payments.refund(intent.id, { reason: "cancelación" }, newId(), who);
    expect(rest).toMatchObject({ status: "REFUNDED", refundedAmount: "77000" });
    expect(await events("PagoReembolsado", o.id)).toHaveLength(2);
    await expect(
      payments.refund(intent.id, { reason: "otra vez" }, newId(), who),
    ).rejects.toMatchObject({
      reason: "NOT_REFUNDABLE",
    });
    const check = await payments.ledgerCheck();
    expect(check.balanced).toBe(true);
    await expect(pool.query("update ledger_entries set amount = 1")).rejects.toThrow(/append-only/);
  });

  it("antifraude: orden no pagable, monto fuera de rango, adquirente caído y máximo de intentos", async () => {
    await expect(
      payments.createIntent(order(undefined, { status: "CONFIRMED" }).id, newId(), who),
    ).rejects.toMatchObject({
      reason: "ORDER_NOT_PAYABLE",
    });
    await expect(
      payments.createIntent(order(undefined, { total: "9000000" }).id, newId(), who),
    ).rejects.toMatchObject({
      reason: "AMOUNT_OUT_OF_RANGE",
    });
    const o = order();
    fake.flags.failCreate = true;
    for (let i = 0; i < 3; i++) {
      await expect(payments.createIntent(o.id, newId(), who)).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
    }
    fake.flags.failCreate = false;
    await expect(payments.createIntent(o.id, newId(), who)).rejects.toMatchObject({
      reason: "TOO_MANY_ATTEMPTS",
    });
  });

  it("HTTP: /internal exige el secreto, el retorno redirige a la orden y solo el dueño ve su pago", async () => {
    const o = order();
    expect(
      (await app.inject({ method: "POST", url: "/internal/payments", payload: { orderId: o.id } }))
        .statusCode,
    ).toBe(404);
    const created = await app.inject({
      method: "POST",
      url: "/internal/payments",
      payload: { orderId: o.id },
      headers: { "x-internal-token": INTERNAL, "idempotency-key": newId() },
    });
    expect(created.statusCode).toBe(201);
    const noKey = await app.inject({
      method: "POST",
      url: "/internal/payments",
      payload: { orderId: o.id },
      headers: { "x-internal-token": INTERNAL },
    });
    expect(noKey.statusCode).toBe(400);

    const token = new URL(created.json().redirectUrl).searchParams.get("token_ws")!;
    fake.submit(token);
    const back = await app.inject({ url: `/v1/return?token_ws=${token}` });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe(`https://localhost:8443/orden/${o.orderCode}?pago=aprobado`);

    const sign = (sub: string, roles = ["customer"]) =>
      new SignJWT({ roles, email_verified: true })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer("ticketera-identity")
        .setAudience("ticketera")
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(accessKey);
    const url = `/v1/payments/${created.json().id}`;
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${await sign(o.userId)}` } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${await sign(newId())}` } }))
        .statusCode,
    ).toBe(404);
    const ledger = await app.inject({
      url: "/v1/admin/ledger/check",
      headers: { authorization: `Bearer ${await sign(newId(), ["admin"])}` },
    });
    expect(ledger.json().balanced).toBe(true);
  });
});
