import { AppError } from "@shared/commons";
import type { AuthGuards } from "@shared/commons/auth";
import { assertIdempotencyKey } from "@shared/commons/db";
import { internalGuard, parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Cart, cartItemSchema } from "./cart.js";
import type { OrderService } from "./service.js";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const schemas = {
  addItems: z.strictObject({
    replaceEventDateId: z.guid().optional(),
    items: z.array(cartItemSchema).min(1).max(20),
  }),
  checkout: z.strictObject({
    buyer: z.strictObject({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
      phone: optionalText(40),
      document: optionalText(40),
    }),
    promoCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,40}$/)
      .nullish()
      .transform((value) => value ?? null),
  }),
  code: z.object({ code: z.string().regex(/^TK-[0-9A-Z]{8}$/) }),
  id: z.object({ id: z.guid() }),
  key: z.object({ key: z.string().min(1).max(120) }),
  promo: z.strictObject({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,40}$/),
    percentOff: z.int().min(1).max(100),
    maxUses: z.int().min(1).max(1_000_000),
    validUntil: z.iso
      .datetime({ offset: true })
      .nullish()
      .transform((value) => (value ? new Date(value) : null)),
    active: z.boolean(),
  }),
};

function userOf(request: FastifyRequest) {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { orders: OrderService; cart: Cart; guards: AuthGuards; internalToken: string },
): void {
  const { orders, cart, guards } = deps;
  const user = { preHandler: guards.required() };
  const admin = { preHandler: guards.required("admin") };
  const internal = { preHandler: internalGuard(deps.internalToken) };

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  // ---------- Carro (Redis) ----------

  app.get("/v1/cart", user, async (request) => ({ items: await cart.get(userOf(request).id) }));

  app.post("/v1/cart/items", user, async (request) => {
    const body = parseInput(schemas.addItems, request.body);
    return { items: await cart.add(userOf(request).id, body.items, body.replaceEventDateId) };
  });

  app.delete("/v1/cart/items/:key", user, async (request) => {
    const { key } = parseInput(schemas.key, request.params);
    const { removed, items } = await cart.remove(userOf(request).id, key);
    return { removed: removed ?? null, items };
  });

  app.delete("/v1/cart", user, async (request, reply) => {
    await cart.clear(userOf(request).id);
    return reply.status(204).send();
  });

  // ---------- Checkout y órdenes ----------

  app.post("/v1/checkout", user, async (request, reply) => {
    const key = assertIdempotencyKey(request.headers["idempotency-key"]);
    const body = parseInput(schemas.checkout, request.body);
    return reply.status(201).send(await orders.checkout(userOf(request).id, body, key));
  });

  app.post("/v1/promos/validate", user, async (request) => {
    const body = parseInput(
      z.strictObject({ code: z.string().trim().min(2).max(40) }),
      request.body,
    );
    return orders.validatePromo(body.code);
  });

  app.get("/v1/orders", user, async (request) => ({
    items: await orders.listMine(userOf(request).id),
  }));

  app.get("/v1/orders/:code", user, async (request) => {
    const { code } = parseInput(schemas.code, request.params);
    const order = await orders.getByCode(code);
    const current = userOf(request);
    // Reemplaza RLS: solo el dueño o un admin ven la orden; ajena = 404.
    if (!order || (order.userId !== current.id && !current.roles.includes("admin"))) {
      throw AppError.notFound("La orden no existe");
    }
    return order;
  });

  app.post("/v1/orders/:code/pay", user, async (request) => {
    const { code } = parseInput(schemas.code, request.params);
    return orders.pay(userOf(request).id, code);
  });

  // ---------- Interno (payments) ----------

  app.get("/internal/orders/:id", internal, async (request) => {
    const { id } = parseInput(schemas.id, request.params);
    return orders.forPayment(id);
  });

  // ---------- Administración ----------

  app.get("/v1/admin/orders", admin, async () => ({ items: await orders.listAll() }));

  app.post("/v1/admin/orders/:id/refund", admin, async (request) => {
    const { id } = parseInput(schemas.id, request.params);
    return orders.adminRefund(id);
  });

  app.get("/v1/admin/promos", admin, async () => ({ items: await orders.listPromos() }));

  app.post("/v1/admin/promos", admin, async (request, reply) => {
    const body = parseInput(schemas.promo, request.body);
    return reply.status(201).send(await orders.savePromo(null, body));
  });

  app.put("/v1/admin/promos/:id", admin, async (request) => {
    const { id } = parseInput(schemas.id, request.params);
    return orders.savePromo(id, parseInput(schemas.promo, request.body));
  });

  app.delete("/v1/admin/promos/:id", admin, async (request, reply) => {
    const { id } = parseInput(schemas.id, request.params);
    await orders.deletePromo(id);
    return reply.status(204).send();
  });
}
