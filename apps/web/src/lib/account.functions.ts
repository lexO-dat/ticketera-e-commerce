import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/middleware";
import type { ApiEventSummary } from "@/lib/catalog.server";
import type { ApiOrder } from "@/lib/orders.functions";
import type { ApiTicket, MyTicket } from "@/lib/tickets.functions";

/** Entrada vigente en la cuenta: datos del acceso, QR y portada del evento. */
export type AccountTicket = MyTicket & { eventSlug: string | null; imageUrl: string | null };

/** Compra pagada (o reembolsada): el historial no muestra pagos rechazados ni pendientes. */
export type Purchase = {
  orderCode: string;
  status: ApiOrder["status"];
  total: number;
  createdAt: string;
  lines: { id: string; kind: string; name: string; quantity: number }[];
};

export type MyAccount = { tickets: AccountTicket[]; purchases: Purchase[] };

const PAID_STATUSES: ApiOrder["status"][] = ["CONFIRMED", "REFUND_PENDING", "REFUNDED"];

export const ORDER_STATUS_LABELS: Record<ApiOrder["status"], string> = {
  PENDING_PAYMENT: "Pendiente de pago",
  CONFIRMED: "Pagada",
  CANCELLED: "Cancelada",
  REFUND_PENDING: "Reembolso en curso",
  REFUNDED: "Reembolsada",
};

/**
 * Cuenta del comprador: sus entradas vigentes (las anuladas por reembolso no se muestran) con el QR
 * y la portada del evento, y el historial de compras pagadas. La propiedad la validan los servicios.
 */
export const myAccount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<MyAccount> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { withQrImages } = await import("./tickets.functions");
    const auth = { accessToken: context.accessToken };
    const [orders, tickets, catalog] = await Promise.all([
      gatewayFetch<{ items: ApiOrder[] }>("/orders/orders", auth),
      // Si tickets o catalog no responden, la cuenta igual muestra lo que tenga.
      gatewayFetch<{ items: ApiTicket[] }>("/tickets/tickets", auth).catch(() => ({ items: [] })),
      gatewayFetch<{ events: ApiEventSummary[] }>("/catalog/events").catch(() => ({ events: [] })),
    ]);
    const events = new Map(catalog.events.map((event) => [event.id, event]));
    const valid = await withQrImages(tickets.items.filter((ticket) => ticket.status !== "VOIDED"));
    return {
      tickets: valid
        .map(({ eventId, ...ticket }) => {
          const event = eventId ? events.get(eventId) : undefined;
          return { ...ticket, eventSlug: event?.slug ?? null, imageUrl: event?.imageUrl ?? null };
        })
        .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "")),
      purchases: orders.items
        .filter((order) => PAID_STATUSES.includes(order.status))
        .map((order) => ({
          orderCode: order.orderCode,
          status: order.status,
          total: Number(order.total),
          createdAt: order.createdAt,
          lines: order.lines.map((line) => ({
            id: line.id,
            kind: line.kind,
            name: line.name,
            quantity: line.quantity,
          })),
        })),
    };
  });
