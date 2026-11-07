import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/middleware";

export type MyOrderTicket = { id: string; ticketCode: string; orderItemId: string };

export type MyOrder = {
  id: string;
  orderCode: string;
  status: string;
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

/**
 * Órdenes del usuario autenticado. Transitorio (strangler): los datos siguen en Supabase hasta la
 * Fase 5; sin RLS, la propiedad se filtra explícitamente por el usuario del token de identity.
 */
export const myOrders = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<MyOrder[]> => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data, error } = await db
      .from("orders")
      .select(
        `id, order_code, status, total, created_at,
         order_items ( id, quantity, unit_price, unit_fee,
           event_dates ( starts_at, events ( title, slug, image_url ), venues ( name, city ) ),
           ticket_types ( name ),
           venue_seats ( row_label, seat_number ) ),
         tickets ( id, ticket_code, order_item_id )`,
      )
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    return (data ?? []).map((order) => ({
      id: order.id,
      orderCode: order.order_code,
      status: order.status,
      total: Number(order.total),
      createdAt: order.created_at,
      items: (order.order_items ?? []).map((item) => {
        const date = item.event_dates;
        const seat = item.venue_seats;
        return {
          id: item.id,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price),
          unitFee: Number(item.unit_fee),
          eventTitle: date?.events?.title ?? "Evento",
          eventSlug: date?.events?.slug ?? "",
          imageUrl: date?.events?.image_url ?? null,
          startsAt: date?.starts_at ?? order.created_at,
          venue: [date?.venues?.name, date?.venues?.city].filter(Boolean).join(" · "),
          ticketName: item.ticket_types?.name ?? "Ticket",
          seatLabel: seat ? `Fila ${seat.row_label} · Butaca ${seat.seat_number}` : null,
          tickets: (order.tickets ?? [])
            .filter((t) => t.order_item_id === item.id)
            .map((t) => ({ id: t.id, ticketCode: t.ticket_code, orderItemId: t.order_item_id })),
        };
      }),
    }));
  });
