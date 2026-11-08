import { AppError } from "@shared/commons";
import type { AuthGuards } from "@shared/commons/auth";
import { assertIdempotencyKey } from "@shared/commons/db";
import { internalGuard, parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Actor, PaymentService } from "./service.js";

const id = z.object({ id: z.guid() });
const refundBody = z.strictObject({
  amount: z
    .union([z.int().positive(), z.string().regex(/^\d{1,13}$/)])
    .transform((value) => BigInt(value))
    .optional(),
  reason: z.string().trim().min(3).max(120),
});

function actorOf(request: FastifyRequest, fallback: string): Actor {
  return {
    actor: request.user ? `user:${request.user.id}` : fallback,
    requestId: request.id,
    ip: request.ip,
  };
}

export function registerRoutes(
  app: FastifyInstance,
  deps: {
    payments: PaymentService;
    guards: AuthGuards;
    internalToken: string;
    /** Destino del navegador tras el retorno: `${webUrl}/orden/<código>?pago=<resultado>`. */
    webUrl: string;
  },
): void {
  const { payments, guards } = deps;
  const internal = { preHandler: internalGuard(deps.internalToken) };
  const admin = { preHandler: guards.required("admin") };

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  // ---------- Interno (orders) ----------

  app.post("/internal/payments", internal, async (request, reply) => {
    const key = assertIdempotencyKey(request.headers["idempotency-key"]);
    const body = parseInput(z.strictObject({ orderId: z.guid() }), request.body);
    const created = await payments.createIntent(
      body.orderId,
      key,
      actorOf(request, "service:orders"),
    );
    return reply.status(201).send(created);
  });

  app.post("/internal/payments/:id/refunds", internal, async (request, reply) => {
    const key = assertIdempotencyKey(request.headers["idempotency-key"]);
    const params = parseInput(id, request.params);
    const body = parseInput(refundBody, request.body);
    return reply
      .status(201)
      .send(await payments.refund(params.id, body, key, actorOf(request, "service:orders")));
  });

  app.get("/internal/payments/by-order/:id", internal, async (request) => {
    const params = parseInput(id, request.params);
    return { items: await payments.listByOrder(params.id) };
  });

  app.post("/internal/payments/reconcile", internal, async () => ({
    expired: await payments.expireStale(),
    reconciled: await payments.reconcileUnknown(),
  }));

  // ---------- Retorno del navegador desde el adquirente (público vía gateway) ----------

  app.get("/v1/return", async (request, reply) => {
    const query = parseInput(
      z.object({
        token_ws: z
          .string()
          .regex(/^[\w-]{1,128}$/)
          .optional(),
        TBK_TOKEN: z
          .string()
          .regex(/^[\w-]{1,128}$/)
          .optional(),
        TBK_ORDEN_COMPRA: z.string().max(26).optional(),
        TBK_ID_SESION: z.string().max(61).optional(),
      }),
      request.query,
    );
    const result = await payments.handleReturn(query, actorOf(request, "browser"));
    // URL de destino fija (configuración): nunca se toma de la solicitud.
    const target = result.orderCode
      ? `${deps.webUrl}/orden/${encodeURIComponent(result.orderCode)}?pago=${result.outcome}`
      : `${deps.webUrl}/carro?pago=rechazado`;
    return reply.redirect(target, 303);
  });

  // ---------- Consulta (dueño o admin) ----------

  app.get("/v1/payments/:id", { preHandler: guards.required() }, async (request) => {
    const params = parseInput(id, request.params);
    const payment = await payments.get(params.id);
    const user = request.user!;
    if (!payment || (payment.userId !== user.id && !user.roles.includes("admin"))) {
      throw AppError.notFound("El pago no existe");
    }
    return payment;
  });

  // ---------- Administración ----------

  app.get("/v1/admin/payments", admin, async (request) => {
    const query = parseInput(z.object({ orderId: z.guid() }), request.query);
    return { items: await payments.listByOrder(query.orderId) };
  });

  app.post("/v1/admin/payments/:id/refunds", admin, async (request, reply) => {
    const key = assertIdempotencyKey(request.headers["idempotency-key"]);
    const params = parseInput(id, request.params);
    const body = parseInput(refundBody, request.body);
    return reply
      .status(201)
      .send(await payments.refund(params.id, body, key, actorOf(request, "admin")));
  });

  app.get("/v1/admin/ledger/check", admin, async () => payments.ledgerCheck());
}
