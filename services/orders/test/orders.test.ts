/**
 * Orders contra Postgres y Redis reales (TEST_DATABASE_URL, TEST_REDIS_URL), con inventory,
 * catalog y payments en memoria. Cubre la saga de compra y la promoción atómica.
 */
import { fileURLToPath } from "node:url";
import { AppError, ErrorCode, createEvent, createLogger, newId } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import { type Pool, createPool, runMigrations } from "@shared/commons/db";
import { type Redis, createRedis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type CartItem, createCart } from "../src/cart.js";
import { handlePaymentEvent } from "../src/payment-events.js";
import type {
  CatalogPort,
  InventoryPort,
  PaymentsPort,
  ReservationView,
  TicketsPort,
} from "../src/ports.js";
import { type OrderService, createOrderService } from "../src/service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "orders-test", level: "silent" });
const INTERNAL = "internal-test-token-0123456789abcdef";

describe.skipIf(!DATABASE_URL || !REDIS_URL)("orders (integración)", () => {
  let pool: Pool;
  let redis: Redis;
  let orders: OrderService;
  let app: FastifyInstance;
  let accessKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const schema = `orders_${newId().replaceAll("-", "").slice(0, 12)}`;
  const prefix = `${schema}:`;

  // ---- Servicios vecinos en memoria ----
  const reservations = new Map<string, ReservationView>();
  const calls = {
    sell: [] as string[],
    release: [] as string[][],
    returned: [] as string[],
    refunds: [] as string[],
    intents: [] as string[],
  };
  const flags = { sellFails: false };
  const inventory: InventoryPort = {
    get: async (id) => reservations.get(id) ?? null,
    async sell(orderId, ids) {
      if (flags.sellFails) throw AppError.conflict("RESERVATION_NOT_ACTIVE", "venció");
      calls.sell.push(orderId);
      for (const id of ids)
        reservations.set(id, { ...reservations.get(id)!, status: "SOLD", orderId });
    },
    async release(ids) {
      calls.release.push(ids);
    },
    async returnSold(orderId) {
      calls.returned.push(orderId);
    },
  };
  const TICKET = newId();
  const PRODUCT = newId();
  const EVENT = newId();
  const catalog: CatalogPort = {
    async resolve(refs) {
      return refs.map((ref) =>
        ref.kind === "ticket_type"
          ? {
              id: ref.id,
              kind: ref.kind,
              name: "Lumen — VIP",
              unitPrice: "100000",
              unitFee: "10000",
              saleable: true,
              unsaleableReason: null,
              maxPerOrder: 8,
              attributes: { eventId: EVENT },
            }
          : {
              id: ref.id,
              kind: ref.kind,
              name: "Polera",
              unitPrice: "20000",
              unitFee: "0",
              saleable: true,
              unsaleableReason: null,
              maxPerOrder: 3,
              attributes: {},
            },
      );
    },
  };
  const payments: PaymentsPort = {
    async createIntent(orderId) {
      calls.intents.push(orderId);
      return {
        id: newId(),
        status: "PENDING",
        redirectUrl: `https://pago.test/form?token_ws=${orderId}`,
      };
    },
    listByOrder: async () => [],
    async refund(paymentId, _reason, key) {
      calls.refunds.push(`${paymentId}|${key}`);
    },
  };

  const checkedIn = new Map<string, number>();
  const tickets: TicketsPort = { checkedInCount: async (orderId) => checkedIn.get(orderId) ?? 0 };

  const buyer = { name: "Ana Pérez", email: "ana@acceptme.com", phone: null, document: null };

  function reservation(userId: string, overrides: Partial<ReservationView> = {}): ReservationView {
    const value: ReservationView = {
      id: newId(),
      userId,
      status: "ACTIVE",
      eventId: EVENT,
      eventDateId: newId(),
      ticketTypeId: TICKET,
      quantity: 2,
      seatIds: [newId(), newId()],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      orderId: null,
      ...overrides,
    };
    reservations.set(value.id, value);
    return value;
  }

  async function fillCart(userId: string, withProduct = false) {
    const r = reservation(userId);
    const items: CartItem[] = [
      // Precio "manipulado" por el cliente: el checkout debe ignorarlo.
      {
        key: `res:${r.id}`,
        kind: "ticket_type",
        itemId: TICKET,
        quantity: 2,
        reservationId: r.id,
        eventId: EVENT,
        eventDateId: r.eventDateId,
        unitPrice: 1,
        unitFee: 0,
      },
    ];
    if (withProduct)
      items.push({
        key: `prod:${PRODUCT}`,
        kind: "product",
        itemId: PRODUCT,
        quantity: 1,
        unitPrice: 1,
        unitFee: 0,
      });
    await createCart(redis, 600).add(userId, items);
    return r;
  }

  const payment = (
    type: "PagoAutorizado" | "PagoRechazado" | "PagoReembolsado",
    data: Record<string, unknown>,
  ) => createEvent({ type, source: "payments", aggregateId: String(data["paymentId"]), data });

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "orders-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({
      connectionString: url.toString(),
      applicationName: "orders-test",
      max: 30,
    });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    redis = createRedis({
      url: REDIS_URL!,
      connectionName: "orders-test",
      logger,
      options: { keyPrefix: prefix },
    });
    const cart = createCart(redis, 600);
    orders = createOrderService({ pool, cart, inventory, catalog, payments, tickets, logger });
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    accessKey = pair.privateKey;
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };
    app = buildApp({
      logger,
      orders,
      cart,
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
      internalToken: INTERNAL,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys.map((k) => k.slice(prefix.length)));
      await redis.quit();
    }
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("checkout: precios del servidor, orden PENDING_PAYMENT, carro vacío y un solo intento de pago", async () => {
    const user = newId();
    await fillCart(user, true);
    const key = newId();
    const result = await orders.checkout(user, { buyer, promoCode: null }, key);
    expect(result.redirectUrl).toContain("token_ws=");
    const order = (await orders.getById(result.orderId))!;
    expect(order).toMatchObject({
      status: "PENDING_PAYMENT",
      subtotal: "220000",
      fees: "20000",
      total: "240000",
    });
    expect(order.lines.map((l) => l.kind).sort()).toEqual(["product", "ticket_type"]);
    expect(await createCart(redis, 600).get(user)).toEqual([]);
    // Reintento con la misma clave: misma respuesta, sin segunda orden ni segundo cobro.
    const replay = await orders.checkout(user, { buyer, promoCode: null }, key);
    expect(replay.orderId).toBe(result.orderId);
    expect(calls.intents.filter((id) => id === result.orderId)).toHaveLength(1);
    const { rows } = await pool.query(
      "select payload from outbox where type = 'OrdenCreada' and aggregate_id = $1",
      [result.orderId],
    );
    expect(rows[0].payload.data).toMatchObject({
      userId: user,
      total: "240000",
      eventIds: [EVENT],
    });
  });

  it("rechaza carro vacío, reservas ajenas o vencidas", async () => {
    await expect(
      orders.checkout(newId(), { buyer, promoCode: null }, newId()),
    ).rejects.toMatchObject({ reason: "CART_EMPTY" });
    const user = newId();
    const r = await fillCart(user);
    reservations.set(r.id, { ...r, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(orders.checkout(user, { buyer, promoCode: null }, newId())).rejects.toMatchObject({
      reason: "RESERVATION_EXPIRED",
    });
    const thief = newId();
    await createCart(redis, 600).add(thief, [
      {
        key: "x",
        kind: "ticket_type",
        itemId: TICKET,
        quantity: 2,
        reservationId: reservation(newId()).id,
        unitPrice: 0,
        unitFee: 0,
      },
    ]);
    await expect(orders.checkout(thief, { buyer, promoCode: null }, newId())).rejects.toMatchObject(
      { reason: "RESERVATION_EXPIRED" },
    );
  });

  it("promoción atómica: 30 compras simultáneas con 5 usos disponibles → exactamente 5 descuentos", async () => {
    await pool.query(
      "insert into promo_codes (id, code, percent_off, max_uses, used_count) values ($1, 'FLASH10', 10, 10, 5)",
      [newId()],
    );
    const users = Array.from({ length: 30 }, () => newId());
    for (const user of users) await fillCart(user);
    const results = await Promise.allSettled(
      users.map((user) => orders.checkout(user, { buyer, promoCode: "flash10" }, newId())),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(5);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => (r.reason as AppError).reason === "PROMO_INVALID"),
    ).toBe(true);
    const { rows } = await pool.query("select used_count from promo_codes where code = 'FLASH10'");
    expect(rows[0].used_count).toBe(10);
    const order = (await orders.getById(
      (ok[0] as PromiseFulfilledResult<{ orderId: string }>).value.orderId,
    ))!;
    expect(order).toMatchObject({
      subtotal: "200000",
      discount: "20000",
      total: "200000",
      promoCode: "FLASH10",
    });
  });

  it("pago autorizado → vende las reservas y confirma (una sola vez aunque el evento llegue repetido)", async () => {
    const user = newId();
    const r = await fillCart(user);
    const { orderId } = await orders.checkout(user, { buyer, promoCode: null }, newId());
    const paymentId = newId();
    const event = payment("PagoAutorizado", { paymentId, orderId, amount: "220000" });
    await handlePaymentEvent(pool, orders, event);
    await handlePaymentEvent(pool, orders, event);
    expect(calls.sell.filter((id) => id === orderId)).toHaveLength(1);
    expect(reservations.get(r.id)!.status).toBe("SOLD");
    expect((await orders.getById(orderId))!).toMatchObject({ status: "CONFIRMED", paymentId });
    const { rows } = await pool.query(
      "select payload from outbox where type = 'OrdenConfirmada' and aggregate_id = $1",
      [orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data.lines[0]).toMatchObject({
      kind: "ticket_type",
      quantity: 2,
      seatIds: r.seatIds,
    });
    expect(rows[0].payload.data.buyerEmail).toBe("ana@acceptme.com");
  });

  it("pago rechazado → orden cancelada, reserva liberada y promoción devuelta", async () => {
    await pool.query(
      "insert into promo_codes (id, code, percent_off, max_uses) values ($1, 'VUELVE', 10, 3)",
      [newId()],
    );
    const user = newId();
    const r = await fillCart(user);
    const { orderId } = await orders.checkout(user, { buyer, promoCode: "VUELVE" }, newId());
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoRechazado", { paymentId: newId(), orderId, reason: "REJECTED" }),
    );
    expect((await orders.getById(orderId))!).toMatchObject({
      status: "CANCELLED",
      cancelReason: "PAYMENT_REJECTED",
    });
    expect(calls.release.some((ids) => ids.includes(r.id))).toBe(true);
    const { rows } = await pool.query("select used_count from promo_codes where code = 'VUELVE'");
    expect(rows[0].used_count).toBe(0);
  });

  it("pago aprobado con la reserva vencida → no se confirma y se reembolsa automáticamente", async () => {
    const user = newId();
    await fillCart(user);
    const { orderId } = await orders.checkout(user, { buyer, promoCode: null }, newId());
    const paymentId = newId();
    flags.sellFails = true;
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoAutorizado", { paymentId, orderId, amount: "220000" }),
    );
    flags.sellFails = false;
    expect((await orders.getById(orderId))!).toMatchObject({
      status: "REFUND_PENDING",
      cancelReason: "LATE_PAYMENT",
    });
    expect(calls.refunds).toContain(`${paymentId}|refund-late-${paymentId}`);
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoReembolsado", { paymentId, orderId, amount: "220000", total: true }),
    );
    expect((await orders.getById(orderId))!.status).toBe("REFUNDED");
    expect(calls.returned).not.toContain(orderId); // nunca se vendió
  });

  it("reembolso admin de una orden confirmada devuelve el cupo a inventory", async () => {
    const user = newId();
    await fillCart(user);
    const { orderId } = await orders.checkout(user, { buyer, promoCode: null }, newId());
    const paymentId = newId();
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoAutorizado", { paymentId, orderId, amount: "220000" }),
    );
    const pending = await orders.adminRefund(orderId);
    expect(pending.status).toBe("REFUND_PENDING");
    expect(calls.refunds).toContain(`${paymentId}|refund-admin-${orderId}`);
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoReembolsado", { paymentId, orderId, amount: "220000", total: true }),
    );
    expect((await orders.getById(orderId))!.status).toBe("REFUNDED");
    expect(calls.returned).toContain(orderId);
    await expect(orders.adminRefund(orderId)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it("no reembolsa una orden con entradas ya validadas en puerta (la butaca no vuelve a la venta)", async () => {
    const user = newId();
    await fillCart(user);
    const { orderId } = await orders.checkout(user, { buyer, promoCode: null }, newId());
    await handlePaymentEvent(
      pool,
      orders,
      payment("PagoAutorizado", { paymentId: newId(), orderId, amount: "220000" }),
    );
    checkedIn.set(orderId, 1);
    await expect(orders.adminRefund(orderId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      reason: "TICKETS_ALREADY_USED",
    });
    expect((await orders.getById(orderId))!.status).toBe("CONFIRMED");
    expect(calls.refunds.some((key) => key.endsWith(`refund-admin-${orderId}`))).toBe(false);
  });

  it("HTTP: carro y órdenes solo del dueño, /internal con secreto y Idempotency-Key obligatoria", async () => {
    const sign = (sub: string, roles = ["customer"]) =>
      new SignJWT({ roles, email_verified: true })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer("ticketera-identity")
        .setAudience("ticketera")
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(accessKey);
    const user = newId();
    const auth = { authorization: `Bearer ${await sign(user)}` };
    const r = reservation(user);
    const added = await app.inject({
      method: "POST",
      url: "/v1/cart/items",
      headers: auth,
      payload: {
        items: [
          {
            key: `res:${r.id}`,
            kind: "ticket_type",
            itemId: TICKET,
            quantity: 2,
            reservationId: r.id,
            unitPrice: 100000,
            unitFee: 10000,
          },
        ],
      },
    });
    expect(added.statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/cart", headers: auth })).json().items).toHaveLength(1);

    const noKey = await app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: auth,
      payload: { buyer },
    });
    expect(noKey.statusCode).toBe(400);
    const checkout = await app.inject({
      method: "POST",
      url: "/v1/checkout",
      headers: { ...auth, "idempotency-key": newId() },
      payload: { buyer },
    });
    expect(checkout.statusCode).toBe(201);
    const { orderCode, orderId } = checkout.json();

    expect((await app.inject({ url: `/v1/orders/${orderCode}`, headers: auth })).statusCode).toBe(
      200,
    );
    const other = { authorization: `Bearer ${await sign(newId())}` };
    expect((await app.inject({ url: `/v1/orders/${orderCode}`, headers: other })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ url: `/internal/orders/${orderId}` })).statusCode).toBe(404);
    const internal = await app.inject({
      url: `/internal/orders/${orderId}`,
      headers: { "x-internal-token": INTERNAL },
    });
    expect(internal.json()).toMatchObject({
      status: "PENDING_PAYMENT",
      total: "220000",
      fees: "20000",
      buyerEmail: "ana@acceptme.com",
    });
    expect((await app.inject({ url: "/v1/admin/orders", headers: auth })).statusCode).toBe(403);
  });
});
