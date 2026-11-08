import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/middleware";
import type { ApiOrder } from "@/lib/orders.functions";

export type MyOrderTicket = { id: string; ticketCode: string; orderItemId: string };

export type MyOrder = {
  id: string;
  orderCode: string;
  status: ApiOrder["status"];
  total: number;
  createdAt: string;
  items: {
    id: string;
    quantity: number;
    unitPrice: number;
    unitFee: number;
    eventTitle: string;
    eventSlug: string;
    imageUrl: string | null;
    startsAt: string;
    venue: string;
    ticketName: string;
    seatLabel: string | null;
    tickets: MyOrderTicket[];
  }[];
};

export const ORDER_STATUS_LABELS: Record<ApiOrder["status"], string> = {
  PENDING_PAYMENT: "Pendiente de pago",
  CONFIRMED: "Pagada",
  CANCELLED: "Cancelada",
  REFUND_PENDING: "Reembolso en curso",
  REFUNDED: "Reembolsada",
};

/** Órdenes del usuario autenticado, desde `orders` (la propiedad la valida el servicio). */
export const myOrders = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<MyOrder[]> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const [{ items }, tickets] = await Promise.all([
      gatewayFetch<{ items: ApiOrder[] }>("/orders/orders", { accessToken: context.accessToken }),
      // Entradas emitidas por `tickets` (si no responde, la cuenta igual muestra las órdenes).
      gatewayFetch<{
        items: { id: string; code: string; orderCode: string; name: string; status: string }[];
      }>("/tickets/tickets", { accessToken: context.accessToken }).catch(() => ({ items: [] })),
    ]);
    return items.map((order) => ({
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      total: Number(order.total),
      createdAt: order.createdAt,
      items: order.lines.map((line) => {
        const attributes = line.attributes;
        const [eventTitle] = line.name.split(" — ");
        return {
          id: line.id,
          quantity: line.quantity,
          unitPrice: Number(line.unitPrice),
          unitFee: Number(line.unitFee),
          eventTitle: eventTitle ?? line.name,
          eventSlug: "",
          imageUrl: null,
          startsAt:
            typeof attributes["startsAt"] === "string" ? attributes["startsAt"] : order.createdAt,
          venue: typeof attributes["venueName"] === "string" ? attributes["venueName"] : "",
          ticketName:
            typeof attributes["sectionName"] === "string" ? attributes["sectionName"] : line.name,
          seatLabel:
            line.seatIds.length > 0 ? `${line.seatIds.length} butaca(s) numerada(s)` : null,
          tickets: tickets.items
            .filter((ticket) => ticket.orderCode === order.orderCode && ticket.name === line.name)
            .map((ticket) => ({ id: ticket.id, ticketCode: ticket.code, orderItemId: line.id })),
        };
      }),
    }));
  });
