import {
  AppError,
  type CLP,
  type Logger,
  clp,
  createEvent,
  newId,
  percentOfClp,
  secureCode,
} from "@shared/commons";
import {
  type Pool,
  type Queryable,
  enqueueOutbox,
  requestHash,
  withIdempotency,
  withTransaction,
} from "@shared/commons/db";
import type { Cart } from "./cart.js";
import type {
  CatalogPort,
  InventoryPort,
  PaymentsPort,
  ReservationView,
  TicketsPort,
} from "./ports.js";

export type OrderStatus =
  "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED";

export interface OrderLineDto {
  id: string;
  kind: string;
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  unitFee: string;
  reservationId: string | null;
  eventId: string | null;
  eventDateId: string | null;
  seatIds: string[];
  attributes: Record<string, unknown>;
}

export interface OrderDto {
  id: string;
  orderCode: string;
  userId: string;
  buyer: { name: string; email: string; phone: string | null; document: string | null };
  subtotal: string;
  fees: string;
  discount: string;
  total: string;
  promoCode: string | null;
  status: OrderStatus;
  cancelReason: string | null;
  paymentId: string | null;
  expiresAt: string;
  createdAt: string;
  confirmedAt: string | null;
  lines: OrderLineDto[];
}

export interface CheckoutInput {
  buyer: { name: string; email: string; phone: string | null; document: string | null };
  promoCode: string | null;
}

interface OrderRow {
  id: string;
  order_code: string;
  user_id: string;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string | null;
  buyer_document: string | null;
  subtotal: bigint;
  fees: bigint;
  discount: bigint;
  total: bigint;
  promo_code: string | null;
  status: OrderStatus;
  cancel_reason: string | null;
  payment_id: string | null;
  expires_at: Date;
  created_at: Date;
  confirmed_at: Date | null;
}

interface LineRow {
  id: string;
  kind: string;
  item_id: string;
  name: string;
  quantity: number;
  unit_price: bigint;
  unit_fee: bigint;
  reservation_id: string | null;
  event_id: string | null;
  event_date_id: string | null;
  seat_ids: string[];
  attributes: Record<string, unknown>;
}

const SOURCE = "orders";
/** Órdenes sin reservas (solo productos) se pueden pagar durante este tiempo. */
const PRODUCT_ONLY_WINDOW_MS = 10 * 60_000;

function toDto(row: OrderRow, lines: LineRow[]): OrderDto {
  return {
    id: row.id,
    orderCode: row.order_code,
    userId: row.user_id,
    buyer: {
      name: row.buyer_name,
      email: row.buyer_email,
      phone: row.buyer_phone,
      document: row.buyer_document,
    },
    subtotal: row.subtotal.toString(),
    fees: row.fees.toString(),
    discount: row.discount.toString(),
    total: row.total.toString(),
    promoCode: row.promo_code,
    status: row.status,
    cancelReason: row.cancel_reason,
    paymentId: row.payment_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    lines: lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      itemId: line.item_id,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unit_price.toString(),
      unitFee: line.unit_fee.toString(),
      reservationId: line.reservation_id,
      eventId: line.event_id,
      eventDateId: line.event_date_id,
      seatIds: line.seat_ids,
      attributes: line.attributes,
    })),
  };
}

export function createOrderService(options: {
  pool: Pool;
  cart: Cart;
  inventory: InventoryPort;
  catalog: CatalogPort;
  payments: PaymentsPort;
  tickets: TicketsPort;
  logger: Logger;
}) {
  const { pool, cart, inventory, catalog, payments, tickets, logger } = options;

  async function load(db: Queryable, where: string, value: string, lock = false) {
    const result = await db.query<OrderRow>(
      `select * from orders where ${where} = $1${lock ? " for update" : ""}`,
      [value],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const lines = await db.query<LineRow>(
      "select * from order_lines where order_id = $1 order by id",
      [row.id],
    );
    return { row, lines: lines.rows };
  }

  async function get(db: Queryable, where: string, value: string): Promise<OrderDto | undefined> {
    const found = await load(db, where, value);
    return found ? toDto(found.row, found.lines) : undefined;
  }

  /** Cambio de estado compare-and-set. */
  async function move(
    db: Queryable,
    orderId: string,
    from: OrderStatus[],
    to: OrderStatus,
    fields: { cancel_reason?: string; payment_id?: string; confirmed?: boolean } = {},
  ): Promise<OrderRow | undefined> {
    const result = await db.query<OrderRow>(
      `update orders set status = $3, updated_at = now(),
         cancel_reason = coalesce($4, cancel_reason), payment_id = coalesce($5, payment_id),
         confirmed_at = case when $6 then now() else confirmed_at end
       where id = $1 and status = any($2::text[]) returning *`,
      [
        orderId,
        from,
        to,
        fields.cancel_reason ?? null,
        fields.payment_id ?? null,
        fields.confirmed ?? false,
      ],
    );
    return result.rows[0];
  }

  async function releasePromo(db: Queryable, code: string | null) {
    if (!code) return;
    await db.query(
      "update promo_codes set used_count = used_count - 1 where code = $1 and used_count > 0",
      [code],
    );
  }

  async function emitCancelled(db: Queryable, order: OrderRow, reason: string) {
    await enqueueOutbox(
      db,
      createEvent({
        type: "OrdenCancelada",
        source: SOURCE,
        aggregateId: order.id,
        data: {
          orderId: order.id,
          userId: order.user_id,
          reason,
          // Para avisar al comprador (notifications).
          orderCode: order.order_code,
          buyerName: order.buyer_name,
          buyerEmail: order.buyer_email,
          total: order.total.toString(),
        },
      }),
    );
  }

  const reservationIdsOf = (lines: LineRow[]) =>
    lines.map((line) => line.reservation_id).filter((id): id is string => id !== null);

  /** Cancela una orden pendiente y libera reservas y promoción (pago rechazado / vencido). */
  async function cancelPending(orderId: string, reason: string) {
    const cancelled = await withTransaction(pool, async (client) => {
      const order = await move(client, orderId, ["PENDING_PAYMENT"], "CANCELLED", {
        cancel_reason: reason,
      });
      if (!order) return undefined;
      await releasePromo(client, order.promo_code);
      await emitCancelled(client, order, reason);
      return order;
    });
    if (!cancelled) return;
    const lines = await pool.query<LineRow>("select * from order_lines where order_id = $1", [
      orderId,
    ]);
    // Liberación inmediata (< 500 ms): las entradas vuelven a estar a la venta.
    await inventory.release(reservationIdsOf(lines.rows), "PAYMENT_FAILED");
  }

  return {
    getById: (id: string) => get(pool, "id", id),
    getByCode: (code: string) => get(pool, "order_code", code),

    async listMine(userId: string): Promise<OrderDto[]> {
      const result = await pool.query<{ id: string }>(
        "select id from orders where user_id = $1 order by created_at desc limit 100",
        [userId],
      );
      const orders = await Promise.all(result.rows.map((row) => get(pool, "id", row.id)));
      return orders.filter((order): order is OrderDto => order !== undefined);
    },

    async listAll(limit = 200): Promise<OrderDto[]> {
      const result = await pool.query<{ id: string }>(
        "select id from orders order by created_at desc limit $1",
        [limit],
      );
      const orders = await Promise.all(result.rows.map((row) => get(pool, "id", row.id)));
      return orders.filter((order): order is OrderDto => order !== undefined);
    },

    async validatePromo(code: string) {
      const result = await pool.query<{
        percent_off: number;
        used_count: number;
        max_uses: number;
        valid: boolean;
        active: boolean;
      }>(
        `select percent_off, used_count, max_uses, active,
                (valid_until is null or valid_until > now()) as valid
         from promo_codes where code = $1`,
        [code.toUpperCase()],
      );
      const promo = result.rows[0];
      if (!promo || !promo.active) return { valid: false as const, reason: "Código no válido" };
      if (promo.used_count >= promo.max_uses)
        return { valid: false as const, reason: "Código agotado" };
      if (!promo.valid) return { valid: false as const, reason: "Código expirado" };
      return { valid: true as const, code: code.toUpperCase(), percentOff: promo.percent_off };
    },

    /**
     * Checkout (saga de compra, paso 1): valida las reservas vigentes del carro, congela precios
     * desde catalog (ItemVendible), consume la promoción de forma atómica, crea la orden
     * PENDING_PAYMENT y pide el cobro a payments con clave de idempotencia.
     */
    async checkout(userId: string, input: CheckoutInput, idempotencyKey: string) {
      const result = await withIdempotency(
        pool,
        { scope: `checkout:${userId}`, key: idempotencyKey, hash: requestHash(input) },
        async () => {
          const items = await cart.get(userId);
          if (items.length === 0) throw AppError.conflict("CART_EMPTY", "Tu carro está vacío");

          // Reservas: deben ser del usuario y seguir vigentes.
          const reservations = new Map<string, ReservationView>();
          for (const item of items) {
            if (!item.reservationId) continue;
            const reservation = await inventory.get(item.reservationId);
            if (
              !reservation ||
              reservation.userId !== userId ||
              reservation.status !== "ACTIVE" ||
              Date.parse(reservation.expiresAt) <= Date.now()
            ) {
              throw AppError.conflict(
                "RESERVATION_EXPIRED",
                "Una de tus reservas venció; vuelve a elegir tus entradas",
              );
            }
            reservations.set(reservation.id, reservation);
          }

          // Precios del servidor, para cualquier tipo de ítem (ASR05: orders no conoce los tipos).
          const lines = items.map((item) => {
            const reservation = item.reservationId
              ? reservations.get(item.reservationId)
              : undefined;
            return {
              kind: item.kind,
              itemId: reservation?.ticketTypeId ?? item.itemId,
              quantity: reservation?.quantity ?? item.quantity,
              reservation,
            };
          });
          const resolved = await catalog.resolve(
            lines.map((line) => ({ kind: line.kind, id: line.itemId })),
          );
          const byKey = new Map(resolved.map((item) => [`${item.kind}:${item.id}`, item]));
          const priced = lines.map((line) => {
            const item = byKey.get(`${line.kind}:${line.itemId}`);
            if (!item)
              throw AppError.conflict("ITEM_UNAVAILABLE", "Un producto del carro ya no existe");
            if (!item.saleable) {
              throw AppError.conflict(
                "ITEM_UNAVAILABLE",
                `${item.name} ya no está a la venta (${item.unsaleableReason})`,
              );
            }
            if (!line.reservation && line.quantity > item.maxPerOrder) {
              throw AppError.conflict(
                "LIMIT_PER_ORDER",
                `Máximo ${item.maxPerOrder} unidades de ${item.name}`,
              );
            }
            return { ...line, item, unitPrice: clp(item.unitPrice), unitFee: clp(item.unitFee) };
          });

          const subtotal = priced.reduce(
            (sum, line) => sum + line.unitPrice * BigInt(line.quantity),
            0n,
          ) as CLP;
          const fees = priced.reduce(
            (sum, line) => sum + line.unitFee * BigInt(line.quantity),
            0n,
          ) as CLP;
          const expiries = [...reservations.values()].map((r) => Date.parse(r.expiresAt));
          const expiresAt = new Date(
            expiries.length > 0 ? Math.min(...expiries) : Date.now() + PRODUCT_ONLY_WINDOW_MS,
          );

          const order = await withTransaction(pool, async (client) => {
            let discount = 0n as CLP;
            let promoCode: string | null = null;
            if (input.promoCode) {
              // Promoción atómica: el contador nunca supera el máximo aunque compren miles a la vez.
              const promo = await client.query<{ percent_off: number }>(
                `update promo_codes set used_count = used_count + 1
                 where code = $1 and active and used_count < max_uses
                   and (valid_until is null or valid_until > now())
                 returning percent_off`,
                [input.promoCode.toUpperCase()],
              );
              const percent = promo.rows[0]?.percent_off;
              if (percent === undefined)
                throw AppError.conflict(
                  "PROMO_INVALID",
                  "El código de descuento no es válido o se agotó",
                );
              discount = percentOfClp(subtotal, percent * 100);
              promoCode = input.promoCode.toUpperCase();
            }
            const id = newId();
            const code = secureCode(8, "TK");
            const inserted = await client.query<OrderRow>(
              `insert into orders (id, order_code, user_id, buyer_name, buyer_email, buyer_phone,
                 buyer_document, subtotal, fees, discount, total, promo_code, status, expires_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING_PAYMENT', $13)
               returning *`,
              [
                id,
                code,
                userId,
                input.buyer.name,
                input.buyer.email.toLowerCase(),
                input.buyer.phone,
                input.buyer.document,
                subtotal,
                fees,
                discount,
                subtotal - discount + fees,
                promoCode,
                expiresAt,
              ],
            );
            for (const line of priced) {
              await client.query(
                `insert into order_lines (id, order_id, kind, item_id, name, quantity, unit_price, unit_fee,
                   reservation_id, event_id, event_date_id, seat_ids, attributes)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                  newId(),
                  id,
                  line.kind,
                  line.itemId,
                  line.item.name,
                  line.quantity,
                  line.unitPrice,
                  line.unitFee,
                  line.reservation?.id ?? null,
                  line.reservation?.eventId ??
                    (line.item.attributes["eventId"] as string | undefined) ??
                    null,
                  line.reservation?.eventDateId ?? null,
                  line.reservation?.seatIds ?? [],
                  JSON.stringify(line.item.attributes),
                ],
              );
            }
            const eventIds = [...new Set([...reservations.values()].map((r) => r.eventId))];
            await enqueueOutbox(
              client,
              createEvent({
                type: "OrdenCreada",
                source: SOURCE,
                aggregateId: id,
                data: { orderId: id, userId, total: inserted.rows[0]!.total.toString(), eventIds },
              }),
            );
            return inserted.rows[0]!;
          });

          // Las líneas ya pertenecen a la orden.
          await cart.clear(userId);
          let redirectUrl: string | null = null;
          try {
            const intent = await payments.createIntent(order.id);
            redirectUrl = intent.redirectUrl;
          } catch (error) {
            // La orden queda pendiente: se puede reintentar el pago mientras la reserva siga vigente.
            logger.warn({ err: error, orderId: order.id }, "no se pudo iniciar el pago");
          }
          return {
            statusCode: 201,
            body: {
              orderId: order.id,
              orderCode: order.order_code,
              total: order.total.toString(),
              redirectUrl,
            },
          };
        },
      );
      return result.body;
    },

    /** Reintenta abrir el pago de una orden pendiente (p. ej. si el adquirente no respondía). */
    async pay(userId: string, orderCode: string) {
      const order = await get(pool, "order_code", orderCode);
      if (!order || order.userId !== userId) throw AppError.notFound("La orden no existe");
      if (order.status !== "PENDING_PAYMENT")
        throw AppError.conflict("ORDER_NOT_PAYABLE", "La orden no está pendiente de pago");
      const intent = await payments.createIntent(order.id);
      return { orderCode, redirectUrl: intent.redirectUrl };
    },

    /** Datos para cobrar (payments): el monto sale de aquí, nunca del cliente. */
    async forPayment(orderId: string) {
      const order = await get(pool, "id", orderId);
      if (!order) throw AppError.notFound("La orden no existe");
      return {
        id: order.id,
        orderCode: order.orderCode,
        userId: order.userId,
        status: order.status,
        total: order.total,
        fees: order.fees,
        buyerEmail: order.buyer.email,
        expiresAt: order.expiresAt,
      };
    },

    /**
     * Pago autorizado: vende las reservas (todo o nada) y confirma. Si las reservas vencieron
     * (pago tardío) o la orden ya no está pendiente, se reembolsa automáticamente: nunca se cobra
     * sin entregar.
     */
    async onPaymentAuthorized(orderId: string, paymentId: string) {
      const found = await load(pool, "id", orderId);
      if (!found) return;
      const { row, lines } = found;
      if (row.status === "REFUND_PENDING" && row.cancel_reason === "LATE_PAYMENT") {
        // Reentrega del evento tras un reembolso que falló: se reintenta (misma clave idempotente).
        await payments.refund(paymentId, "LATE_PAYMENT", `refund-late-${paymentId}`);
        return;
      }
      if (
        row.status === "CONFIRMED" ||
        row.status === "REFUND_PENDING" ||
        row.status === "REFUNDED"
      ) {
        if (row.payment_id && row.payment_id !== paymentId) {
          // Segundo cobro de la misma orden (no debería pasar): se devuelve.
          await payments.refund(paymentId, "DUPLICATE_PAYMENT", `refund-dup-${paymentId}`);
        }
        return;
      }
      let sold = false;
      if (row.status === "PENDING_PAYMENT") {
        try {
          await inventory.sell(orderId, reservationIdsOf(lines));
          sold = true;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error; // reintenta el evento
          logger.warn({ orderId }, "pago aprobado con la reserva vencida: reembolso automático");
        }
      }
      if (sold) {
        await withTransaction(pool, async (client) => {
          const confirmed = await move(client, orderId, ["PENDING_PAYMENT"], "CONFIRMED", {
            payment_id: paymentId,
            confirmed: true,
          });
          if (!confirmed) return;
          await enqueueOutbox(
            client,
            createEvent({
              type: "OrdenConfirmada",
              source: SOURCE,
              aggregateId: orderId,
              data: {
                orderId,
                orderCode: confirmed.order_code,
                userId: confirmed.user_id,
                total: confirmed.total.toString(),
                buyerName: confirmed.buyer_name,
                buyerEmail: confirmed.buyer_email,
                lines: lines.map((line) => ({
                  lineId: line.id,
                  kind: line.kind,
                  itemId: line.item_id,
                  name: line.name,
                  quantity: line.quantity,
                  unitPrice: line.unit_price.toString(),
                  unitFee: line.unit_fee.toString(),
                  eventId: line.event_id,
                  eventDateId: line.event_date_id,
                  seatIds: line.seat_ids,
                  // Datos para mostrar la entrada (del ItemVendible congelado en la orden).
                  attributes: line.attributes,
                })),
              },
            }),
          );
        });
        return;
      }
      // Pago tardío o con la orden ya cancelada: se marca para reembolso y se libera lo reservado.
      await withTransaction(pool, async (client) => {
        const moved = await move(
          client,
          orderId,
          ["PENDING_PAYMENT", "CANCELLED"],
          "REFUND_PENDING",
          {
            cancel_reason: "LATE_PAYMENT",
            payment_id: paymentId,
          },
        );
        if (moved && row.status === "PENDING_PAYMENT") await releasePromo(client, moved.promo_code);
      });
      await inventory.release(reservationIdsOf(lines), "LATE_PAYMENT");
      await payments.refund(paymentId, "LATE_PAYMENT", `refund-late-${paymentId}`);
    },

    /** Pago rechazado, anulado o vencido: cancela y libera la reserva al instante. */
    async onPaymentRejected(orderId: string, reason: string) {
      await cancelPending(orderId, `PAYMENT_${reason}`);
    },

    /** Reembolso hecho: la orden queda REFUNDED y, si se había vendido, el cupo vuelve a la venta. */
    async onPaymentRefunded(orderId: string, total: boolean) {
      if (!total) return;
      const wasConfirmed = await withTransaction(pool, async (client) => {
        const before = await load(client, "id", orderId, true);
        if (!before || !["CONFIRMED", "REFUND_PENDING"].includes(before.row.status)) return false;
        await move(client, orderId, ["CONFIRMED", "REFUND_PENDING"], "REFUNDED", {
          cancel_reason: before.row.cancel_reason ?? "REFUNDED",
        });
        await emitCancelled(client, before.row, "REFUNDED");
        return before.row.confirmed_at !== null;
      });
      if (wasConfirmed) await inventory.returnSold(orderId);
    },

    /** Reembolso pedido por un admin (orden confirmada). */
    async adminRefund(orderId: string) {
      const order = await get(pool, "id", orderId);
      if (!order) throw AppError.notFound("La orden no existe");
      if (order.status !== "CONFIRMED" || !order.paymentId) {
        throw AppError.conflict("NOT_REFUNDABLE", "Solo se reembolsan órdenes confirmadas");
      }
      // Una entrada ya usada no se anula: reembolsar devolvería la butaca a la venta y el nuevo
      // comprador no podría recibir su entrada (el asiento sigue ocupado por la validada).
      if ((await tickets.checkedInCount(orderId)) > 0) {
        throw AppError.conflict(
          "TICKETS_ALREADY_USED",
          "La orden tiene entradas ya validadas en puerta; no se puede reembolsar",
        );
      }
      await move(pool, orderId, ["CONFIRMED"], "REFUND_PENDING", { cancel_reason: "ADMIN_REFUND" });
      try {
        await payments.refund(order.paymentId, "ADMIN_REFUND", `refund-admin-${orderId}`);
      } catch (error) {
        await move(pool, orderId, ["REFUND_PENDING"], "CONFIRMED");
        throw error;
      }
      return (await get(pool, "id", orderId))!;
    },

    /**
     * Job: órdenes pendientes cuyo pago nunca se inició (payments caído) y ya vencieron.
     * Las que tienen intento las cierra payments (PagoRechazado EXPIRED).
     */
    async expireStale(graceSeconds = 300): Promise<number> {
      const due = await pool.query<{ id: string }>(
        `select id from orders where status = 'PENDING_PAYMENT'
           and expires_at < now() - make_interval(secs => $1) limit 50`,
        [graceSeconds],
      );
      for (const { id } of due.rows) {
        const intents = await payments.listByOrder(id).catch(() => undefined);
        if (intents === undefined) continue;
        if (
          intents.some((intent) =>
            ["CREATED", "PENDING", "UNKNOWN", "AUTHORIZED"].includes(intent.status),
          )
        )
          continue;
        await cancelPending(id, "EXPIRED");
      }
      return due.rows.length;
    },

    // ---------- Promociones (admin) ----------

    async listPromos() {
      const result = await pool.query("select * from promo_codes order by created_at desc");
      return result.rows.map((row) => ({
        id: row.id as string,
        code: row.code as string,
        percentOff: row.percent_off as number,
        maxUses: row.max_uses as number,
        usedCount: row.used_count as number,
        validUntil: row.valid_until ? (row.valid_until as Date).toISOString() : null,
        active: row.active as boolean,
        createdAt: (row.created_at as Date).toISOString(),
      }));
    },

    async savePromo(
      id: string | null,
      input: {
        code: string;
        percentOff: number;
        maxUses: number;
        validUntil: Date | null;
        active: boolean;
      },
    ) {
      try {
        if (id) {
          const result = await pool.query(
            `update promo_codes set code = $2, percent_off = $3, max_uses = greatest($4, used_count),
               valid_until = $5, active = $6 where id = $1`,
            [id, input.code, input.percentOff, input.maxUses, input.validUntil, input.active],
          );
          if (result.rowCount === 0) throw AppError.notFound("El código no existe");
          return { id };
        }
        const newIdValue = newId();
        await pool.query(
          `insert into promo_codes (id, code, percent_off, max_uses, valid_until, active)
           values ($1, $2, $3, $4, $5, $6)`,
          [newIdValue, input.code, input.percentOff, input.maxUses, input.validUntil, input.active],
        );
        return { id: newIdValue };
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw AppError.conflict("PROMO_EXISTS", "Ya existe ese código");
        throw error;
      }
    },

    async deletePromo(id: string) {
      await pool.query("delete from promo_codes where id = $1", [id]);
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
