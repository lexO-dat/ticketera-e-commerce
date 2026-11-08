import { AppError, ErrorCode, type Logger, createEvent, newId, secureCode } from "@shared/commons";
import {
  type Pool,
  type PoolClient,
  type Queryable,
  enqueueOutbox,
  requestHash,
  withIdempotency,
  withTransaction,
} from "@shared/commons/db";
import {
  type PaymentProvider,
  type ProviderTransaction,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "./provider.js";

export type IntentStatus =
  | "CREATED"
  | "PENDING"
  | "AUTHORIZED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED"
  | "UNKNOWN"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

/** Lo que payments necesita de la orden (siempre del servidor: nunca montos del cliente). */
export interface OrderForPayment {
  id: string;
  orderCode: string;
  userId: string;
  status: string;
  total: string;
  fees: string;
  buyerEmail: string;
  expiresAt: string;
}

export interface OrdersPort {
  getForPayment(orderId: string): Promise<OrderForPayment>;
}

export interface PaymentDto {
  id: string;
  orderId: string;
  orderCode: string;
  userId: string;
  amount: string;
  status: IntentStatus;
  provider: string;
  buyOrder: string;
  authorizationCode: string | null;
  cardLast4: string | null;
  failureReason: string | null;
  refundedAmount: string;
  expiresAt: string;
  createdAt: string;
}

export interface Actor {
  actor: string;
  requestId?: string | undefined;
  ip?: string | undefined;
}

interface IntentRow {
  id: string;
  order_id: string;
  order_code: string;
  user_id: string;
  amount: bigint;
  fees: bigint;
  status: IntentStatus;
  provider: string;
  provider_token: string | null;
  provider_url: string | null;
  buy_order: string;
  session_id: string;
  payer_email: string;
  expires_at: Date;
  authorization_code: string | null;
  card_last4: string | null;
  failure_reason: string | null;
  refunded_amount: bigint;
  created_at: Date;
  updated_at: Date;
}

const SOURCE = "payments";
const LIVE: IntentStatus[] = ["CREATED", "PENDING", "AUTHORIZED", "UNKNOWN", "REFUND_PENDING"];

export function toDto(row: IntentRow): PaymentDto {
  return {
    id: row.id,
    orderId: row.order_id,
    orderCode: row.order_code,
    userId: row.user_id,
    amount: row.amount.toString(),
    status: row.status,
    provider: row.provider,
    buyOrder: row.buy_order,
    authorizationCode: row.authorization_code,
    cardLast4: row.card_last4,
    failureReason: row.failure_reason,
    refundedAmount: row.refunded_amount.toString(),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/** Resultado del retorno del navegador, para la página de la orden. */
export type ReturnOutcome = "aprobado" | "rechazado" | "anulado" | "expirado" | "pendiente";

export function outcomeOf(status: IntentStatus): ReturnOutcome {
  switch (status) {
    case "AUTHORIZED":
    case "REFUND_PENDING":
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "aprobado";
    case "FAILED":
      return "rechazado";
    case "CANCELED":
      return "anulado";
    case "EXPIRED":
      return "expirado";
    default:
      return "pendiente";
  }
}

export interface PaymentServiceOptions {
  pool: Pool;
  provider: PaymentProvider;
  orders: OrdersPort;
  logger: Logger;
  /** URL de retorno fija (configuración): nunca se acepta desde el cliente. */
  returnUrl: string;
  maxAmount: bigint;
  maxFailedAttemptsPerOrder: number;
  /** Margen tras `expires_at` antes de dar por vencido un intento sin respuesta. */
  expiryGraceSeconds: number;
}

export function createPaymentService(options: PaymentServiceOptions) {
  const { pool, provider, orders, logger } = options;

  async function load(db: Queryable, id: string, lock = false): Promise<IntentRow | undefined> {
    const result = await db.query<IntentRow>(
      `select * from payment_intents where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return result.rows[0];
  }

  async function audit(
    db: Queryable,
    intentId: string,
    from: IntentStatus | null,
    to: IntentStatus,
    who: Actor,
    reason?: string | null,
    payload?: unknown,
  ) {
    await db.query(
      `insert into payment_attempt_events
         (intent_id, from_status, to_status, reason, provider_payload, actor, request_id, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        intentId,
        from,
        to,
        reason ?? null,
        payload ? JSON.stringify(payload) : null,
        who.actor,
        who.requestId ?? null,
        who.ip ?? null,
      ],
    );
  }

  /** Compare-and-set del estado: si otro proceso ya lo movió, no hace nada. */
  async function transition(
    db: Queryable,
    intent: IntentRow,
    to: IntentStatus,
    who: Actor,
    fields: Record<string, unknown> = {},
    reason?: string | null,
    payload?: unknown,
  ): Promise<boolean> {
    const columns = Object.keys(fields);
    const sets = columns.map((column, index) => `${column} = $${index + 4}`);
    const result = await db.query(
      `update payment_intents set status = $3, updated_at = now()${sets.length ? `, ${sets.join(", ")}` : ""}
       where id = $1 and status = $2`,
      [intent.id, intent.status, to, ...columns.map((column) => fields[column])],
    );
    if (result.rowCount === 0) return false;
    await audit(db, intent.id, intent.status, to, who, reason, payload);
    return true;
  }

  async function ledger(db: Queryable, intentId: string, entries: [string, bigint][]) {
    const total = entries.reduce((sum, [, amount]) => sum + amount, 0n);
    if (total !== 0n) throw new Error("asiento desbalanceado");
    const transactionId = newId();
    for (const [account, amount] of entries) {
      if (amount === 0n) continue;
      await db.query(
        "insert into ledger_entries (transaction_id, account, amount, intent_id) values ($1, $2, $3, $4)",
        [transactionId, account, amount, intentId],
      );
    }
  }

  /**
   * Aplica el resultado del adquirente (commit o status) en una sola transacción: estado, ledger y
   * evento en el outbox. Valida monto y orden de compra contra el intento.
   */
  async function applyResult(
    client: PoolClient,
    intent: IntentRow,
    result: ProviderTransaction,
    who: Actor,
  ) {
    const payload = {
      status: result.status,
      responseCode: result.responseCode,
      amount: result.amount,
      authorizationCode: result.authorizationCode,
      cardLast4: result.cardLast4,
    };
    const approved = result.status === "AUTHORIZED" && result.responseCode === 0;
    const mismatch =
      result.amount !== Number(intent.amount) || result.buyOrder !== intent.buy_order;
    if (approved && mismatch) {
      logger.error(
        { intentId: intent.id, payload },
        "ALERTA: el adquirente devolvió otro monto u orden",
      );
    }
    if (approved && !mismatch) {
      const moved = await transition(
        client,
        intent,
        "AUTHORIZED",
        who,
        {
          authorization_code: result.authorizationCode,
          card_last4: result.cardLast4,
          payment_type: result.paymentType,
        },
        null,
        payload,
      );
      if (!moved) return;
      await ledger(client, intent.id, [
        ["customer_payments", -intent.amount],
        ["merchant_payable", intent.amount - intent.fees],
        ["platform_fees", intent.fees],
      ]);
      await enqueueOutbox(
        client,
        createEvent({
          type: "PagoAutorizado",
          source: SOURCE,
          aggregateId: intent.id,
          correlationId: who.requestId,
          data: {
            paymentId: intent.id,
            orderId: intent.order_id,
            amount: intent.amount.toString(),
            authorizationCode: result.authorizationCode,
          },
        }),
      );
      return;
    }
    if (result.status === "INITIALIZED") return; // el comprador aún no paga
    const reason = mismatch && approved ? "AMOUNT_MISMATCH" : (result.reason ?? "REJECTED");
    await fail(client, intent, "FAILED", reason, who, payload);
  }

  async function fail(
    db: Queryable,
    intent: IntentRow,
    to: "FAILED" | "CANCELED" | "EXPIRED",
    reason: string,
    who: Actor,
    payload?: unknown,
  ) {
    const moved = await transition(
      db,
      intent,
      to,
      who,
      { failure_reason: reason },
      reason,
      payload,
    );
    if (!moved) return;
    await enqueueOutbox(
      db,
      createEvent({
        type: "PagoRechazado",
        source: SOURCE,
        aggregateId: intent.id,
        correlationId: who.requestId,
        data: { paymentId: intent.id, orderId: intent.order_id, reason },
      }),
    );
  }

  /** Lee el estado en el adquirente y lo aplica (conciliación). */
  async function reconcileOne(intentId: string, who: Actor, expireIfInitialized: boolean) {
    await withTransaction(pool, async (client) => {
      const intent = await load(client, intentId, true);
      if (!intent || !["PENDING", "UNKNOWN", "CREATED"].includes(intent.status)) return;
      if (!intent.provider_token) {
        await fail(client, intent, "FAILED", "PROVIDER_UNAVAILABLE", who);
        return;
      }
      let result: ProviderTransaction;
      try {
        result = await provider.status(intent.provider_token);
      } catch (error) {
        logger.warn({ err: error, intentId }, "conciliación: adquirente sin respuesta");
        return;
      }
      if (result.status === "INITIALIZED") {
        if (expireIfInitialized) await fail(client, intent, "EXPIRED", "EXPIRED", who);
        return;
      }
      await applyResult(client, intent, result, who);
    });
  }

  return {
    async get(id: string): Promise<PaymentDto | undefined> {
      const row = await load(pool, id);
      return row ? toDto(row) : undefined;
    },

    async listByOrder(orderId: string): Promise<PaymentDto[]> {
      const result = await pool.query<IntentRow>(
        "select * from payment_intents where order_id = $1 order by created_at",
        [orderId],
      );
      return result.rows.map(toDto);
    },

    /**
     * Crea (idempotente) el intento de una orden e inicia la transacción en el adquirente.
     * El monto sale de `orders`; el vencimiento es el de la reserva.
     */
    async createIntent(orderId: string, idempotencyKey: string, who: Actor) {
      const result = await withIdempotency(
        pool,
        { scope: "create-intent", key: idempotencyKey, hash: requestHash({ orderId }) },
        async () => {
          const order = await orders.getForPayment(orderId);
          const amount = BigInt(order.total);
          if (order.status !== "PENDING_PAYMENT") {
            throw AppError.conflict("ORDER_NOT_PAYABLE", "La orden no está pendiente de pago");
          }
          if (Date.parse(order.expiresAt) <= Date.now()) {
            throw AppError.conflict("ORDER_EXPIRED", "La reserva de la orden venció");
          }
          if (amount <= 0n || amount > options.maxAmount) {
            throw AppError.conflict("AMOUNT_OUT_OF_RANGE", "Monto fuera del rango permitido");
          }

          const intent = await withTransaction(pool, async (client) => {
            // Serializa por orden: un intento vivo a la vez (el índice único es la última defensa).
            await client.query("select pg_advisory_xact_lock(hashtext($1))", [orderId]);
            const live = await client.query<IntentRow>(
              "select * from payment_intents where order_id = $1 and status = any($2::text[]) limit 1",
              [orderId, LIVE],
            );
            if (live.rows[0]) return live.rows[0];
            const failed = await client.query<{ n: string }>(
              "select count(*) as n from payment_intents where order_id = $1",
              [orderId],
            );
            if (Number(failed.rows[0]!.n) >= options.maxFailedAttemptsPerOrder) {
              throw AppError.conflict(
                "TOO_MANY_ATTEMPTS",
                "Se superó el máximo de intentos de pago de la orden",
              );
            }
            const id = newId();
            const inserted = await client.query<IntentRow>(
              `insert into payment_intents (id, order_id, order_code, user_id, amount, fees, status,
                 provider, buy_order, session_id, payer_email, expires_at, idempotency_key)
               values ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8, $9, $10, $11, $12) returning *`,
              [
                id,
                order.id,
                order.orderCode,
                order.userId,
                amount,
                BigInt(order.fees),
                provider.name,
                secureCode(23, "TK"), // "TK-" + 23 = 26 caracteres (máximo de Webpay)
                order.userId,
                order.buyerEmail,
                order.expiresAt,
                idempotencyKey,
              ],
            );
            await audit(client, id, null, "CREATED", who);
            return inserted.rows[0]!;
          });

          if (intent.status === "CREATED") {
            let created: { token: string; url: string };
            try {
              created = await provider.create({
                buyOrder: intent.buy_order,
                sessionId: intent.session_id,
                amount: Number(intent.amount),
                returnUrl: options.returnUrl,
                payerEmail: intent.payer_email,
              });
            } catch (error) {
              logger.warn({ err: error, intentId: intent.id }, "adquirente no disponible al crear");
              await withTransaction(pool, (client) =>
                fail(client, intent, "FAILED", "PROVIDER_UNAVAILABLE", who),
              );
              throw AppError.unavailable(
                "El medio de pago no está disponible; intenta en un momento",
                5,
              );
            }
            await withTransaction(pool, (client) =>
              transition(client, intent, "PENDING", who, {
                provider_token: created.token,
                provider_url: created.url,
              }),
            );
            return {
              statusCode: 201,
              body: {
                ...toDto({ ...intent, status: "PENDING" }),
                redirectUrl: `${created.url}?token_ws=${created.token}`,
              },
            };
          }
          // Ya había un intento vivo (reintento con otra clave): se devuelve el mismo formulario.
          const fresh = (await load(pool, intent.id))!;
          return {
            statusCode: 200,
            body: {
              ...toDto(fresh),
              redirectUrl:
                fresh.status === "PENDING" && fresh.provider_token && fresh.provider_url
                  ? `${fresh.provider_url}?token_ws=${fresh.provider_token}`
                  : null,
            },
          };
        },
      );
      return result.body;
    },

    /**
     * Retorno del navegador desde el adquirente. El resultado se decide **solo** con la respuesta
     * del commit/status, nunca con los parámetros de la URL. Commit una sola vez (lock de fila).
     */
    async handleReturn(
      query: Record<string, string | undefined>,
      who: Actor,
    ): Promise<{ orderCode: string | null; outcome: ReturnOutcome }> {
      const tokenWs = query["token_ws"];
      const tbkToken = query["TBK_TOKEN"];
      const buyOrder = query["TBK_ORDEN_COMPRA"];
      const lookup = tokenWs ?? tbkToken;

      const byToken = async () => {
        if (lookup) {
          const result = await pool.query<{ id: string }>(
            "select id from payment_intents where provider_token = $1",
            [lookup],
          );
          return result.rows[0]?.id;
        }
        if (buyOrder) {
          const result = await pool.query<{ id: string }>(
            "select id from payment_intents where buy_order = $1",
            [buyOrder],
          );
          return result.rows[0]?.id;
        }
        return undefined;
      };
      const intentId = await byToken();
      if (!intentId) return { orderCode: null, outcome: "rechazado" };

      if (tokenWs && tbkToken) {
        // Error en el formulario: se consulta el estado.
        await reconcileOne(intentId, who, false);
      } else if (tbkToken) {
        await withTransaction(pool, async (client) => {
          const intent = await load(client, intentId, true);
          if (intent?.status === "PENDING") await fail(client, intent, "CANCELED", "CANCELED", who);
        });
      } else if (!tokenWs && buyOrder) {
        await withTransaction(pool, async (client) => {
          const intent = await load(client, intentId, true);
          if (intent?.status === "PENDING")
            await fail(client, intent, "EXPIRED", "FORM_TIMEOUT", who);
        });
      } else if (tokenWs) {
        await withTransaction(pool, async (client) => {
          const intent = await load(client, intentId, true);
          if (!intent || intent.status !== "PENDING") return; // retorno repetido: ya se procesó
          try {
            const result = await provider.commit(tokenWs);
            await applyResult(client, intent, result, who);
          } catch (error) {
            if (error instanceof ProviderRejectedError) {
              // Commit no aceptado (repetido, o el comprador no pagó): manda el estado real.
              const result = await provider.status(tokenWs).catch(() => undefined);
              if (result) await applyResult(client, intent, result, who);
              return;
            }
            if (error instanceof ProviderUnavailableError) {
              await transition(client, intent, "UNKNOWN", who, {}, "COMMIT_NO_RESPONSE");
              return;
            }
            throw error;
          }
        });
      }
      const intent = (await load(pool, intentId))!;
      return { orderCode: intent.order_code, outcome: outcomeOf(intent.status) };
    },

    /** Reembolso total o parcial (idempotente). */
    async refund(
      intentId: string,
      input: { amount?: bigint | undefined; reason: string },
      idempotencyKey: string,
      who: Actor,
    ) {
      const result = await withIdempotency(
        pool,
        {
          scope: "refund",
          key: idempotencyKey,
          hash: requestHash({
            intentId,
            amount: input.amount?.toString() ?? null,
            reason: input.reason,
          }),
        },
        async () => {
          const prepared = await withTransaction(pool, async (client) => {
            const intent = await load(client, intentId, true);
            if (!intent) throw AppError.notFound("El pago no existe");
            if (intent.status !== "AUTHORIZED" && intent.status !== "PARTIALLY_REFUNDED") {
              throw AppError.conflict(
                "NOT_REFUNDABLE",
                "El pago no se puede reembolsar en su estado actual",
              );
            }
            const remaining = intent.amount - intent.refunded_amount;
            const amount = input.amount ?? remaining;
            if (amount <= 0n || amount > remaining) {
              throw new AppError(ErrorCode.VALIDATION, undefined, {
                issues: [{ path: "amount", message: `Máximo reembolsable: ${remaining}` }],
              });
            }
            const refundId = newId();
            await client.query(
              `insert into refunds (id, intent_id, amount, status, reason, idempotency_key)
               values ($1, $2, $3, 'PENDING', $4, $5)`,
              [refundId, intent.id, amount, input.reason, idempotencyKey],
            );
            await transition(client, intent, "REFUND_PENDING", who, {}, input.reason);
            return { intent, amount, refundId };
          });

          const { intent, amount, refundId } = prepared;
          let providerResult: { type: string; balance: number };
          try {
            providerResult = await provider.refund(intent.provider_token!, Number(amount));
          } catch (error) {
            await withTransaction(pool, async (client) => {
              await client.query(
                "update refunds set status = 'FAILED', finished_at = now() where id = $1",
                [refundId],
              );
              const current = (await load(client, intent.id, true))!;
              await transition(client, current, intent.status, who, {}, "REFUND_FAILED");
            });
            logger.warn({ err: error, intentId }, "reembolso rechazado por el adquirente");
            throw AppError.unavailable("No se pudo reembolsar ahora; intenta en un momento", 5);
          }

          const refunded = await withTransaction(pool, async (client) => {
            const current = (await load(client, intent.id, true))!;
            const totalRefunded = current.refunded_amount + amount;
            const to: IntentStatus =
              totalRefunded >= current.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
            await client.query(
              "update refunds set status = 'SUCCEEDED', provider_type = $2, finished_at = now() where id = $1",
              [refundId, providerResult.type],
            );
            await transition(
              client,
              current,
              to,
              who,
              { refunded_amount: totalRefunded },
              input.reason,
              providerResult,
            );
            await ledger(client, intent.id, [
              ["customer_payments", amount],
              ["refunds", -amount],
            ]);
            await enqueueOutbox(
              client,
              createEvent({
                type: "PagoReembolsado",
                source: SOURCE,
                aggregateId: intent.id,
                correlationId: who.requestId,
                data: {
                  paymentId: intent.id,
                  orderId: intent.order_id,
                  amount: amount.toString(),
                  total: to === "REFUNDED",
                  reason: input.reason,
                },
              }),
            );
            return (await load(client, intent.id))!;
          });
          return { statusCode: 201, body: toDto(refunded) };
        },
      );
      return result.body;
    },

    /**
     * Job expirador (30 s): intentos PENDING vencidos (más un margen) se consultan en el
     * adquirente; si no están autorizados, quedan EXPIRED. CREATED colgados (caída) → FAILED.
     */
    async expireStale(limit = 50): Promise<number> {
      const due = await pool.query<{ id: string }>(
        `select id from payment_intents
         where (status = 'PENDING' and expires_at < now() - make_interval(secs => $1))
            or (status = 'CREATED' and created_at < now() - interval '2 minutes')
         order by expires_at limit $2`,
        [options.expiryGraceSeconds, limit],
      );
      for (const { id } of due.rows) await reconcileOne(id, { actor: "job:expirer" }, true);
      return due.rows.length;
    },

    /** Job conciliador (1 min): intentos UNKNOWN (commit sin respuesta) se resuelven con status. */
    async reconcileUnknown(limit = 50): Promise<number> {
      const due = await pool.query<{ id: string; expired: boolean }>(
        `select id, expires_at < now() - make_interval(secs => $1) as expired
         from payment_intents where status = 'UNKNOWN' order by updated_at limit $2`,
        [options.expiryGraceSeconds, limit],
      );
      for (const row of due.rows)
        await reconcileOne(row.id, { actor: "job:reconciler" }, row.expired);
      return due.rows.length;
    },

    /** Cierre: cada asiento suma 0 y saldos por cuenta. */
    async ledgerCheck() {
      const unbalanced = await pool.query<{ transaction_id: string; total: string }>(
        "select transaction_id, sum(amount)::text as total from ledger_entries group by transaction_id having sum(amount) <> 0",
      );
      const balances = await pool.query<{ account: string; balance: string }>(
        "select account, sum(amount)::text as balance from ledger_entries group by account order by account",
      );
      const total = balances.rows.reduce((sum, row) => sum + BigInt(row.balance), 0n);
      return {
        balanced: unbalanced.rows.length === 0 && total === 0n,
        unbalancedTransactions: unbalanced.rows.map((row) => row.transaction_id),
        balances: Object.fromEntries(balances.rows.map((row) => [row.account, row.balance])),
      };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
