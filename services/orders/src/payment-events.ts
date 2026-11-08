import type { EventEnvelope } from "@shared/commons";
import { type Pool, markProcessed, withTransaction } from "@shared/commons/db";
import type { OrderService } from "./service.js";

const CONSUMER = "orders.payment-events";

export const PAYMENT_SUBSCRIPTION = {
  queue: CONSUMER,
  bindings: ["payments.PagoAutorizado.*", "payments.PagoRechazado.*", "payments.PagoReembolsado.*"],
};

/**
 * Consumidor de la saga (docs/services/payments.md §7). Los efectos son idempotentes por estado
 * (compare-and-set) y por clave en los otros servicios; el inbox evita reprocesar un evento ya
 * aplicado. Si un paso falla, el evento se reintenta (y termina en la DLQ si persiste).
 */
export async function handlePaymentEvent(pool: Pool, orders: OrderService, event: EventEnvelope) {
  const seen = await pool.query("select 1 from inbox where consumer = $1 and event_id = $2", [
    CONSUMER,
    event.id,
  ]);
  if ((seen.rowCount ?? 0) > 0) return;

  const data = event.data as {
    orderId: string;
    paymentId: string;
    reason?: string;
    total?: boolean;
  };
  if (event.type === "PagoAutorizado")
    await orders.onPaymentAuthorized(data.orderId, data.paymentId);
  else if (event.type === "PagoRechazado")
    await orders.onPaymentRejected(data.orderId, data.reason ?? "REJECTED");
  else if (event.type === "PagoReembolsado")
    await orders.onPaymentRefunded(data.orderId, data.total !== false);

  await withTransaction(pool, (client) => markProcessed(client, CONSUMER, event.id));
}
