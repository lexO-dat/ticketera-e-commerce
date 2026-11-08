import { randomInt, randomUUID } from "node:crypto";
import { safeEqual } from "@shared/commons";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MockStore, MockTransaction } from "./store.js";

/**
 * Imita la API REST de Webpay Plus (Transbank) v1.2 y su formulario de pago (ADR-07). Es el único
 * mock del sistema. Decide por el email del pagador (`X-Mock-Payer-Email`, extensión del mock):
 * `@acceptme.com` aprueba, `@rejectme.com` rechaza, otro dominio según `defaultOutcome`.
 */
export interface MockOptions {
  apiKeyId: string;
  apiKeySecret: string;
  /** URL pública del formulario (la ve el navegador). */
  formUrl: string;
  defaultOutcome: "accept" | "reject";
  latencyMs: number;
  /** Fracción de commits que se procesan pero cuya respuesta "se pierde" (504). */
  commitLossRatio: number;
  /** Fracción de solicitudes al API que fallan con 500 antes de hacer nada. */
  errorRatio: number;
}

const API = "/rswebpaytransaction/api/webpay/v1.2/transactions";

const createSchema = z.object({
  buy_order: z.string().min(1).max(26),
  session_id: z.string().min(1).max(61),
  amount: z.number().int().positive().max(1_000_000_000),
  return_url: z.url().max(256),
});
const refundSchema = z.object({ amount: z.number().int().positive() });
const tokenParams = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

function tbkError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ error_message: message });
}

function outcome(email: string | null, fallback: "accept" | "reject") {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (domain === "acceptme.com") return { approved: true, reason: null };
  if (domain === "rejectme.com") return { approved: false, reason: "ISSUER_REJECTED" };
  return fallback === "accept"
    ? { approved: true, reason: null }
    : { approved: false, reason: "UNSUPPORTED_TEST_EMAIL" };
}

/** Cuerpo de commit / status con el formato de Transbank (solo últimos 4 dígitos). */
function transactionBody(tx: MockTransaction) {
  const date = tx.committedAt ?? tx.createdAt;
  return {
    vci: tx.status === "AUTHORIZED" ? "TSY" : "TSN",
    amount: tx.amount,
    status: tx.status,
    buy_order: tx.buyOrder,
    session_id: tx.sessionId,
    card_detail: { card_number: "6623" },
    accounting_date: date.slice(5, 7) + date.slice(8, 10),
    transaction_date: date,
    authorization_code: tx.authorizationCode,
    payment_type_code: "VN",
    response_code: tx.responseCode,
    installments_number: 0,
    ...(tx.status !== "INITIALIZED" && tx.status !== "FAILED" ? { balance: tx.balance } : {}),
    ...(tx.mockReason ? { mock_reason: tx.mockReason } : {}),
  };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function formPage(tx: MockTransaction): string {
  const amount = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(
    tx.amount,
  );
  const token = escapeHtml(tx.token);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webpay (simulado)</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f1ec;color:#1d1d1b;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;padding:32px;border-radius:16px;max-width:380px;width:calc(100% - 32px);box-shadow:0 8px 30px #0001}
h1{font-size:20px;margin:0 0 4px} p{margin:6px 0;color:#555} .amount{font-size:32px;color:#1d1d1b;margin:16px 0}
.warn{background:#fff6e0;border-radius:8px;padding:10px;font-size:13px}
form{display:inline} button{font:inherit;padding:12px 20px;border-radius:999px;border:0;cursor:pointer;margin:16px 8px 0 0}
.pay{background:#d6001c;color:#fff} .cancel{background:#eee}
</style></head><body><main>
<h1>Webpay Plus</h1><p>Orden de compra ${escapeHtml(tx.buyOrder)}</p>
<div class="amount">${amount}</div>
<p class="warn">Adquirente simulado (ADR-07). El resultado depende del email del comprador:
@acceptme.com aprueba, @rejectme.com rechaza. No ingreses datos de tarjeta reales.</p>
<form method="post" action="/webpay/form/pay"><input type="hidden" name="token_ws" value="${token}"><button class="pay">Pagar</button></form>
<form method="post" action="/webpay/form/cancel"><input type="hidden" name="token_ws" value="${token}"><button class="cancel">Anular compra</button></form>
</main></body></html>`;
}

export function registerRoutes(app: FastifyInstance, store: MockStore, options: MockOptions): void {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function apiGuard(request: FastifyRequest, reply: FastifyReply) {
    const id = request.headers["tbk-api-key-id"];
    const secret = request.headers["tbk-api-key-secret"];
    if (
      typeof id !== "string" ||
      typeof secret !== "string" ||
      !safeEqual(id, options.apiKeyId) ||
      !safeEqual(secret, options.apiKeySecret)
    ) {
      return tbkError(reply, 401, "Not Authorized");
    }
    if (options.latencyMs > 0) await sleep(options.latencyMs);
    if (options.errorRatio > 0 && Math.random() < options.errorRatio) {
      return tbkError(reply, 500, "Internal error (simulado)");
    }
    return undefined;
  }

  app.post(API, { preHandler: apiGuard }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return tbkError(reply, 422, "Invalid parameters");
    const email = request.headers["x-mock-payer-email"];
    const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await store.create({
      token,
      buyOrder: parsed.data.buy_order,
      sessionId: parsed.data.session_id,
      amount: parsed.data.amount,
      returnUrl: parsed.data.return_url,
      payerEmail: typeof email === "string" ? email : null,
      status: "INITIALIZED",
      submitted: false,
      aborted: false,
      committed: false,
      responseCode: null,
      authorizationCode: null,
      mockReason: null,
      balance: 0,
      createdAt: new Date().toISOString(),
      committedAt: null,
    });
    return { token, url: options.formUrl };
  });

  app.put(`${API}/:token`, { preHandler: apiGuard }, async (request, reply) => {
    const params = tokenParams.safeParse(request.params);
    if (!params.success) return tbkError(reply, 422, "Invalid token");
    const tx = await store.get(params.data.token);
    if (!tx) return tbkError(reply, 404, "Transaction not found");
    if (tx.aborted || !tx.submitted) {
      return tbkError(
        reply,
        422,
        `Invalid status '${tx.status}' for transaction while authorizing`,
      );
    }
    const decision = outcome(tx.payerEmail, options.defaultOutcome);
    const committed = await store.updateIf(
      tx.token,
      { field: "committed", equals: "false" },
      {
        committed: true,
        committedAt: new Date().toISOString(),
        status: decision.approved ? "AUTHORIZED" : "FAILED",
        responseCode: decision.approved ? 0 : -1,
        authorizationCode: decision.approved ? String(randomInt(100000, 999999)) : null,
        mockReason: decision.reason,
        balance: decision.approved ? tx.amount : 0,
      },
    );
    // Commit repetido: Transbank responde 422 (hay que consultar el estado, no reintentar).
    if (!committed) return tbkError(reply, 422, "Transaction already locked by another process");
    if (options.commitLossRatio > 0 && Math.random() < options.commitLossRatio) {
      await sleep(100);
      return tbkError(reply, 504, "Gateway timeout (respuesta perdida, simulado)");
    }
    return transactionBody(committed);
  });

  app.get(`${API}/:token`, { preHandler: apiGuard }, async (request, reply) => {
    const params = tokenParams.safeParse(request.params);
    if (!params.success) return tbkError(reply, 422, "Invalid token");
    const tx = await store.get(params.data.token);
    if (!tx) return tbkError(reply, 404, "Transaction not found");
    return transactionBody(tx);
  });

  app.post(`${API}/:token/refunds`, { preHandler: apiGuard }, async (request, reply) => {
    const params = tokenParams.safeParse(request.params);
    const body = refundSchema.safeParse(request.body);
    if (!params.success || !body.success) return tbkError(reply, 422, "Invalid parameters");
    const tx = await store.get(params.data.token);
    if (!tx) return tbkError(reply, 404, "Transaction not found");
    if (!["AUTHORIZED", "PARTIALLY_NULLIFIED"].includes(tx.status)) {
      return tbkError(reply, 422, `Invalid status '${tx.status}' for refund`);
    }
    if (body.data.amount > tx.balance) return tbkError(reply, 422, "Amount exceeds balance");
    const balance = tx.balance - body.data.amount;
    // Reversa: monto total el mismo día; si no, anulación (total o parcial).
    const sameDay = (tx.committedAt ?? "").slice(0, 10) === new Date().toISOString().slice(0, 10);
    const type = sameDay && tx.status === "AUTHORIZED" && balance === 0 ? "REVERSED" : "NULLIFIED";
    const updated = await store.updateIf(
      tx.token,
      { field: "balance", equals: String(tx.balance) },
      {
        balance,
        status:
          type === "REVERSED" ? "REVERSED" : balance === 0 ? "NULLIFIED" : "PARTIALLY_NULLIFIED",
      },
    );
    if (!updated) return tbkError(reply, 422, "Concurrent refund, retry");
    return {
      type,
      authorization_code: String(randomInt(100000, 999999)),
      authorization_date: new Date().toISOString(),
      nullified_amount: body.data.amount,
      balance,
      response_code: 0,
    };
  });

  // ---------- Formulario de pago (lo ve el navegador) ----------

  app.get("/webpay/form", async (request, reply) => {
    const token = (request.query as { token_ws?: string }).token_ws ?? "";
    const tx = /^[0-9a-f]{64}$/.test(token) ? await store.get(token) : undefined;
    reply
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:",
      )
      .header("x-frame-options", "DENY")
      .header("cache-control", "no-store");
    if (!tx || tx.committed || tx.aborted) {
      return reply
        .status(410)
        .type("text/html")
        .send("<p>Transacción inválida o ya procesada.</p>");
    }
    return reply.type("text/html; charset=utf-8").send(formPage(tx));
  });

  async function formAction(
    request: FastifyRequest,
    reply: FastifyReply,
    action: "pay" | "cancel",
  ) {
    const token = (request.body as { token_ws?: string } | undefined)?.token_ws ?? "";
    const tx = /^[0-9a-f]{64}$/.test(token) ? await store.get(token) : undefined;
    if (!tx || tx.committed || tx.aborted) {
      return reply
        .status(410)
        .type("text/html")
        .send("<p>Transacción inválida o ya procesada.</p>");
    }
    const url = new URL(tx.returnUrl);
    if (action === "pay") {
      await store.updateIf(tx.token, { field: "aborted", equals: "false" }, { submitted: true });
      url.searchParams.set("token_ws", tx.token);
    } else {
      await store.updateIf(tx.token, { field: "submitted", equals: "false" }, { aborted: true });
      url.searchParams.set("TBK_TOKEN", tx.token);
      url.searchParams.set("TBK_ORDEN_COMPRA", tx.buyOrder);
      url.searchParams.set("TBK_ID_SESION", tx.sessionId);
    }
    // Webpay real vuelve con un POST; el mock usa 303 (GET) hacia la misma return_url.
    return reply.redirect(url.toString(), 303);
  }

  app.post("/webpay/form/pay", (request, reply) => formAction(request, reply, "pay"));
  app.post("/webpay/form/cancel", (request, reply) => formAction(request, reply, "cancel"));
}
