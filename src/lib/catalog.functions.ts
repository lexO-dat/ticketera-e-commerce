import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type {
  ApiEventDate,
  ApiEventSummary,
  ApiQueueSettings,
  ApiSeatMap,
  ApiVenue,
} from "./catalog.server";

/**
 * Catálogo público: lo sirve el microservicio `catalog` a través del gateway, con caché de lectura
 * en Redis. La ocupación (vendidas + reservadas) y las butacas tomadas vienen de `inventory`.
 */

export type CatalogEvent = {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: string;
  description: string | null;
  imageUrl: string | null;
  status: string;
  featured: boolean;
  urgencyNote: string | null;
  ageRestriction: string | null;
  nextDate: string | null;
  city: string | null;
  venueName: string | null;
  minPrice: number | null;
  soldRatio: number;
  datesCount: number;
};

function toCatalogEvent(event: ApiEventSummary): CatalogEvent {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    artist: event.artist,
    category: event.category,
    description: event.description,
    imageUrl: event.imageUrl,
    status: event.status,
    featured: event.featured,
    urgencyNote: event.urgencyNote,
    ageRestriction: event.ageRestriction,
    nextDate: event.nextDate,
    city: event.city,
    venueName: event.venueName,
    minPrice: event.minPrice === null ? null : Number(event.minPrice),
    soldRatio: 0,
    datesCount: event.datesCount,
  };
}

/**
 * Ocupadas (vendidas + reservadas vigentes) por tipo de entrada, desde inventory. Si inventory no
 * responde, el catálogo se sigue mostrando (la reserva igual valida la disponibilidad real).
 */
async function soldByTicketType(eventId: string): Promise<Map<string, number>> {
  const { gatewayFetch } = await import("./auth/gateway.server");
  try {
    const { items } = await gatewayFetch<{
      items: { ticketTypeId: string; capacity: number; available: number }[];
    }>(`/inventory/availability/events/${eventId}`);
    return new Map(items.map((item) => [item.ticketTypeId, item.capacity - item.available]));
  } catch {
    return new Map();
  }
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    [400, 404].includes(Number((error as { status: unknown }).status))
  );
}

const listSchema = z.object({
  category: z.string().optional(),
  city: z.string().optional(),
  q: z.string().optional(),
  sort: z.enum(["date", "popular", "price"]).optional(),
});

export const listEvents = createServerFn({ method: "GET" })
  .validator((input: unknown) => listSchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const result = await gatewayFetch<{ events: ApiEventSummary[]; cities: string[] }>(
      `/catalog/events${queryString(data)}`,
    );
    return { events: result.events.map(toCatalogEvent), cities: result.cities };
  });

export const getEvent = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ slug: z.string().max(80) }).parse(input))
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    let event: ApiEventSummary & { dates: ApiEventDate[]; queue: ApiQueueSettings };
    try {
      event = await gatewayFetch(`/catalog/events/${encodeURIComponent(data.slug)}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    const sold = await soldByTicketType(event.id);
    const queue = event.queue.enabled
      ? {
          enabled: true,
          concurrentSlots: event.queue.concurrentSlots,
          windowMinutes: event.queue.windowMinutes,
          waitingMessage: event.queue.waitingMessage,
          opensAt: event.queue.opensAt,
        }
      : null;

    return {
      event: toCatalogEvent(event),
      dates: event.dates.map((date) => ({
        id: date.id,
        startsAt: date.startsAt,
        doorsAt: date.doorsAt,
        onSale: date.onSale,
        venue: date.venue,
        tickets: date.ticketTypes.map((type) => ({
          id: type.id,
          name: type.name,
          price: Number(type.price),
          fee: Number(type.fee),
          capacity: type.capacity,
          sold: sold.get(type.id) ?? 0,
          sectionId: type.sectionId,
          sectionKind: type.sectionKind,
          sortOrder: type.sortOrder,
        })),
      })),
      queue,
    };
  });

export const getSeatMap = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ eventDateId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    let map: ApiSeatMap;
    try {
      map = await gatewayFetch<ApiSeatMap>(`/catalog/dates/${data.eventDateId}/seat-map`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    // Ocupación en vivo (inventory): butacas vendidas o reservadas y cupos de sectores generales.
    const [taken, sold] = await Promise.all([
      gatewayFetch<{ unavailableSeatIds: string[] }>(
        `/inventory/availability/dates/${data.eventDateId}/seats`,
      )
        .then((result) => new Set(result.unavailableSeatIds))
        .catch(() => new Set<string>()),
      soldByTicketType(map.date.event.id),
    ]);

    return {
      date: {
        id: map.date.id,
        startsAt: map.date.startsAt,
        onSale: map.date.onSale,
        event: map.date.event,
        venue: {
          id: map.date.venue.id,
          name: map.date.venue.name,
          city: map.date.venue.city,
          map_width: map.date.venue.mapWidth,
          map_height: map.date.venue.mapHeight,
        },
      },
      sections: map.sections.map((section) => ({
        id: section.id,
        name: section.name,
        kind: section.kind,
        capacity: section.capacity,
        sortOrder: section.sortOrder,
        x: section.shape.x,
        y: section.shape.y,
        w: section.shape.w,
        h: section.shape.h,
      })),
      tickets: map.ticketTypes.map((type) => ({
        id: type.id,
        name: type.name,
        price: Number(type.price),
        fee: Number(type.fee),
        capacity: type.capacity,
        sold: sold.get(type.id) ?? 0,
        sectionId: type.sectionId,
      })),
      seats: map.seats.map((seat) => ({
        id: seat.id,
        sectionId: seat.sectionId,
        row: seat.row,
        number: seat.number,
        x: seat.x,
        y: seat.y,
        unavailable: seat.blocked || taken.has(seat.id),
      })),
    };
  });

export const listVenues = createServerFn({ method: "GET" }).handler(async () => {
  const { gatewayFetch } = await import("./auth/gateway.server");
  const { items } = await gatewayFetch<{ items: ApiVenue[] }>("/catalog/venues");
  return items.map((venue) => ({
    id: venue.id,
    name: venue.name,
    city: venue.city,
    address: venue.address,
    capacity: venue.capacity,
    venue_sections: venue.sections.map((section) => ({
      id: section.id,
      name: section.name,
      kind: section.kind,
      capacity: section.capacity,
    })),
  }));
});

export const subscribeNewsletter = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ email: z.string().email() }).parse(input))
  .handler(async ({ data }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db
      .from("newsletter_subscribers")
      .upsert({ email: data.email.toLowerCase() }, { onConflict: "email" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const trackMetric = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        eventId: z.string().uuid(),
        kind: z.enum(["view", "add_to_cart", "checkout", "purchase"]),
        quantity: z.number().int().min(1).max(20).default(1),
        amount: z.number().min(0).default(0),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Métricas: siguen en el prototipo; sin Supabase configurado se omiten.
    if (!process.env["SUPABASE_URL"]) return { ok: false };
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    await db.from("event_metrics").insert({
      event_id: data.eventId,
      kind: data.kind,
      quantity: data.quantity,
      amount: data.amount,
    });
    return { ok: true };
  });
