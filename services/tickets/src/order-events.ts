import type { EventEnvelope } from "@shared/commons";
import { type Pool, markProcessed, withTransaction } from "@shared/commons/db";
import type { ConfirmedOrder, TicketService } from "./service.js";

const CONSUMER = "tickets.order-events";

export const ORDER_SUBSCRIPTION = {
  queue: CONSUMER,
  bindings: ["orders.OrdenConfirmada.*", "orders.OrdenCancelada.*"],
};

/**
 * `OrdenConfirmada` → emite las entradas (idempotente por línea y unidad). `OrdenCancelada` con
 * reembolso → anula las entradas de esa orden. El inbox evita reprocesar un evento ya aplicado.
 */
export async function handleOrderEvent(pool: Pool, tickets: TicketService, event: EventEnvelope) {
  const seen = await pool.query("select 1 from inbox where consumer = $1 and event_id = $2", [
    CONSUMER,
    event.id,
  ]);
  if ((seen.rowCount ?? 0) > 0) return;
  if (event.type === "OrdenConfirmada") {
    await tickets.issue(event.data as unknown as ConfirmedOrder);
  } else if (event.type === "OrdenCancelada") {
    const data = event.data as { orderId: string; reason: string };
    await tickets.voidOrder(data.orderId, data.reason);
  }
  await withTransaction(pool, (client) => markProcessed(client, CONSUMER, event.id));
}
