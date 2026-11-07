import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const EVENT_SELECT = `
  id, slug, title, artist, category, description, image_url, status, featured, urgency_note, age_restriction,
  event_dates ( id, starts_at, doors_at, on_sale, venue_id, venues ( id, name, city ),
    ticket_types ( id, name, price, service_fee, capacity, sold, section_id ) )
`;

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

type RawEvent = {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: string;
  description: string | null;
  image_url: string | null;
  status: string;
  featured: boolean;
  urgency_note: string | null;
  age_restriction: string | null;
  event_dates: Array<{
    id: string;
    starts_at: string;
    doors_at: string | null;
    on_sale: boolean;
    venue_id: string;
    venues: { id: string; name: string; city: string } | null;
    ticket_types: Array<{
      id: string;
      name: string;
      price: number | string;
      service_fee: number | string;
      capacity: number;
      sold: number;
      section_id: string;
    }>;
  }>;
};

function shape(row: RawEvent): CatalogEvent {
  const dates = [...row.event_dates].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const first = dates[0];
  const prices = dates.flatMap((d) => d.ticket_types.map((t) => Number(t.price)));
  const capacity = dates.reduce(
    (acc, d) => acc + d.ticket_types.reduce((s, t) => s + t.capacity, 0),
    0,
  );
  const sold = dates.reduce((acc, d) => acc + d.ticket_types.reduce((s, t) => s + t.sold, 0), 0);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    artist: row.artist,
    category: row.category,
    description: row.description,
    imageUrl: row.image_url,
    status: row.status,
    featured: row.featured,
    urgencyNote: row.urgency_note,
    ageRestriction: row.age_restriction,
    nextDate: first?.starts_at ?? null,
    city: first?.venues?.city ?? null,
    venueName: first?.venues?.name ?? null,
    minPrice: prices.length ? Math.min(...prices) : null,
    soldRatio: capacity > 0 ? sold / capacity : 0,
    datesCount: dates.length,
  };
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
    const { publicDb } = await import("./db.server");
    const { data: rows, error } = await publicDb()
      .from("events")
      .select(EVENT_SELECT)
      .in("status", ["published", "soldout"]);
    if (error) throw new Error(error.message);

    let events = ((rows ?? []) as unknown as RawEvent[]).map(shape);

    if (data.category) events = events.filter((e) => e.category === data.category);
    if (data.city) events = events.filter((e) => e.city === data.city);
    if (data.q) {
      const q = data.q.toLowerCase();
      events = events.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.artist ?? "").toLowerCase().includes(q) ||
          (e.venueName ?? "").toLowerCase().includes(q),
      );
    }

    const sort = data.sort ?? "date";
    events.sort((a, b) => {
      if (sort === "popular") return b.soldRatio - a.soldRatio;
      if (sort === "price") return (a.minPrice ?? 0) - (b.minPrice ?? 0);
      return (a.nextDate ?? "").localeCompare(b.nextDate ?? "");
    });

    const cities = [...new Set(events.map((e) => e.city).filter(Boolean))] as string[];
    return { events, cities };
  });

export const getEvent = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ slug: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const { publicDb } = await import("./db.server");
    const db = publicDb();
    const { data: row, error } = await db
      .from("events")
      .select(EVENT_SELECT)
      .eq("slug", data.slug)
      .in("status", ["published", "soldout"])
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return null;

    const raw = row as unknown as RawEvent;
    const { data: queue } = await db
      .from("queue_config")
      .select("enabled, concurrent_slots, window_minutes, waiting_message, simulated_queue_size")
      .eq("event_id", raw.id)
      .maybeSingle();

    const { data: sections } = await db
      .from("venue_sections")
      .select("id, name, kind, capacity, sort_order, venue_id");

    const dates = [...raw.event_dates]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .map((d) => ({
        id: d.id,
        startsAt: d.starts_at,
        doorsAt: d.doors_at,
        onSale: d.on_sale,
        venue: d.venues,
        tickets: d.ticket_types
          .map((t) => {
            const section = (sections ?? []).find((s) => s.id === t.section_id);
            return {
              id: t.id,
              name: t.name,
              price: Number(t.price),
              fee: Number(t.service_fee),
              capacity: t.capacity,
              sold: t.sold,
              sectionId: t.section_id,
              sectionKind: section?.kind ?? "seated",
              sortOrder: section?.sort_order ?? 0,
            };
          })
          .sort((a, b) => a.sortOrder - b.sortOrder),
      }));

    return {
      event: shape(raw),
      dates,
      queue: queue
        ? {
            enabled: queue.enabled,
            concurrentSlots: queue.concurrent_slots,
            windowMinutes: queue.window_minutes,
            waitingMessage: queue.waiting_message,
            simulatedQueueSize: queue.simulated_queue_size,
          }
        : null,
    };
  });

export const getSeatMap = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ eventDateId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { publicDb } = await import("./db.server");
    const db = publicDb();

    const { data: date, error } = await db
      .from("event_dates")
      .select(
        "id, starts_at, venue_id, on_sale, events ( id, slug, title, status ), venues ( id, name, city, map_width, map_height )",
      )
      .eq("id", data.eventDateId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!date) return null;

    const [{ data: sections }, { data: tickets }, { data: holds }] = await Promise.all([
      db
        .from("venue_sections")
        .select("id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h")
        .eq("venue_id", date.venue_id)
        .order("sort_order"),
      db
        .from("ticket_types")
        .select("id, name, price, service_fee, capacity, sold, section_id")
        .eq("event_date_id", data.eventDateId),
      db
        .from("seat_holds")
        .select("seat_id, expires_at, sold")
        .eq("event_date_id", data.eventDateId),
    ]);

    const sectionIds = (sections ?? []).map((s) => s.id);
    const { data: seats } = sectionIds.length
      ? await db
          .from("venue_seats")
          .select("id, section_id, row_label, seat_number, x, y, blocked")
          .in("section_id", sectionIds)
      : { data: [] };

    const now = Date.now();
    const taken = new Set(
      (holds ?? [])
        .filter((h) => h.sold || new Date(h.expires_at).getTime() > now)
        .map((h) => h.seat_id),
    );

    return {
      date: {
        id: date.id,
        startsAt: date.starts_at,
        onSale: date.on_sale,
        event: date.events,
        venue: date.venues,
      },
      sections: (sections ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        capacity: s.capacity,
        sortOrder: s.sort_order,
        x: s.shape_x,
        y: s.shape_y,
        w: s.shape_w,
        h: s.shape_h,
      })),
      tickets: (tickets ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        price: Number(t.price),
        fee: Number(t.service_fee),
        capacity: t.capacity,
        sold: t.sold,
        sectionId: t.section_id,
      })),
      seats: (seats ?? []).map((s) => ({
        id: s.id,
        sectionId: s.section_id,
        row: s.row_label,
        number: s.seat_number,
        x: Number(s.x),
        y: Number(s.y),
        unavailable: s.blocked || taken.has(s.id),
      })),
    };
  });

export const listVenues = createServerFn({ method: "GET" }).handler(async () => {
  const { publicDb } = await import("./db.server");
  const { data, error } = await publicDb()
    .from("venues")
    .select("id, name, city, address, capacity, venue_sections ( id, name, kind, capacity )")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
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
