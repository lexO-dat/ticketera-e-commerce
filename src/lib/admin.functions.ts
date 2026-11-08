import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";
import type { ApiEvent, ApiVenue } from "@/lib/catalog.server";
import type { ApiOrder } from "@/lib/orders.functions";

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { legacy } = await import("./catalog.server");

    // Catálogo: microservicio catalog. Órdenes, métricas y fila: prototipo hasta sus fases.
    const { items: events } = await gatewayFetch<{ items: ApiEvent[] }>("/catalog/admin/events", {
      accessToken: context.accessToken,
    });
    const ordersResult = await gatewayFetch<{ items: ApiOrder[] }>("/orders/admin/orders", {
      accessToken: context.accessToken,
    }).catch(() => ({ items: [] as ApiOrder[] }));
    const orders = ordersResult.items.map((o) => ({
      id: o.id,
      order_code: o.orderCode,
      buyer_name: o.buyer.name,
      buyer_email: o.buyer.email,
      total: Number(o.total),
      status: o.status === "CONFIRMED" ? "paid" : o.status.toLowerCase(),
      created_at: o.createdAt,
    }));
    // Métricas del embudo: siguen en el prototipo hasta la Fase 8.
    const metrics = await legacy(
      async () => {
        const { adminDb } = await import("./db.server");
        const db = await adminDb();
        const { data } = await db
          .from("event_metrics")
          .select("event_id, kind, quantity, amount, created_at")
          .limit(5000);
        return data ?? [];
      },
      [] as {
        event_id: string;
        kind: string;
        quantity: number;
        amount: number | string;
        created_at: string;
      }[],
    );

    const paid = orders.filter((o) => o.status === "paid");
    const revenue = paid.reduce((s, o) => s + Number(o.total), 0);
    const types = events.flatMap((e) => e.dates.flatMap((d) => d.ticketTypes));
    const capacity = types.reduce((s, t) => s + t.capacity, 0);
    // Ocupación (inventory) y fila virtual (queue) de los eventos publicados.
    const live = events.filter((e) => e.status === "published");
    const auth = { accessToken: context.accessToken };
    const [availability, queueStats] = await Promise.all([
      Promise.all(
        live.map((e) =>
          gatewayFetch<{ items: { capacity: number; available: number; sold: number }[] }>(
            `/inventory/availability/events/${e.id}`,
          ).catch(() => ({ items: [] })),
        ),
      ),
      Promise.all(
        live
          .filter((e) => e.queue.enabled)
          .map((e) =>
            gatewayFetch<{ waiting: number; active: number; prequeue: number }>(
              `/queue/admin/events/${e.id}`,
              auth,
            ).catch(() => ({ waiting: 0, active: 0, prequeue: 0 })),
          ),
      ),
    ]);
    const ticketsSold = availability.flatMap((a) => a.items).reduce((s, i) => s + i.sold, 0);

    const days = new Map<string, { date: string; revenue: number; orders: number }>();
    for (const order of paid) {
      const key = order.created_at.slice(0, 10);
      const entry = days.get(key) ?? { date: key, revenue: 0, orders: 0 };
      entry.revenue += Number(order.total);
      entry.orders += 1;
      days.set(key, entry);
    }

    const funnel = { view: 0, add_to_cart: 0, checkout: 0, purchase: 0 } as Record<string, number>;
    const perEvent = new Map<string, { views: number; revenue: number }>();
    for (const m of metrics) {
      funnel[m.kind] = (funnel[m.kind] ?? 0) + m.quantity;
      const entry = perEvent.get(m.event_id) ?? { views: 0, revenue: 0 };
      if (m.kind === "view") entry.views += m.quantity;
      entry.revenue += Number(m.amount);
      perEvent.set(m.event_id, entry);
    }

    const topEvents = events
      .map((e) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        status: e.status,
        views: perEvent.get(e.id)?.views ?? 0,
        revenue: perEvent.get(e.id)?.revenue ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue || b.views - a.views)
      .slice(0, 6);

    const queueCounts = { waiting: 0, active: 0, expired: 0 } as Record<string, number>;
    for (const q of queueStats) {
      queueCounts["waiting"] = (queueCounts["waiting"] ?? 0) + q.waiting + q.prequeue;
      queueCounts["active"] = (queueCounts["active"] ?? 0) + q.active;
    }

    return {
      kpis: {
        revenue,
        orders: paid.length,
        ticketsSold,
        capacity,
        occupancy: capacity > 0 ? ticketsSold / capacity : 0,
        avgTicket: paid.length > 0 ? revenue / paid.length : 0,
        publishedEvents: events.filter((e) => e.status === "published").length,
      },
      series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
      funnel,
      topEvents,
      queueCounts,
      recentOrders: orders.slice(0, 8),
    };
  });

/** Evento del catálogo con la forma que espera el panel (heredada del prototipo). */
function toAdminEvent(event: ApiEvent, sold: Map<string, number>) {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    artist: event.artist,
    category: event.category as (typeof EVENT_CATEGORIES)[number],
    status: event.status as (typeof EVENT_STATUSES)[number],
    featured: event.featured,
    image_id: event.imageId,
    image_url: event.imageUrl,
    description: event.description,
    urgency_note: event.urgencyNote,
    age_restriction: event.ageRestriction,
    event_dates: event.dates.map((date) => ({
      id: date.id,
      starts_at: date.startsAt,
      doors_at: date.doorsAt,
      on_sale: date.onSale,
      venue_id: date.venue.id,
      venues: { name: date.venue.name, city: date.venue.city },
      ticket_types: date.ticketTypes.map((type) => ({
        id: type.id,
        name: type.name,
        price: Number(type.price),
        service_fee: Number(type.fee),
        capacity: type.capacity,
        sold: sold.get(type.id) ?? 0,
        section_id: type.sectionId,
      })),
    })),
    queue_config: {
      enabled: event.queue.enabled,
      opens_at: event.queue.opensAt,
      concurrent_slots: event.queue.concurrentSlots,
      window_minutes: event.queue.windowMinutes,
      admit_batch_max: event.queue.admitBatchMax,
      waiting_message: event.queue.waitingMessage,
    },
  };
}

const EVENT_CATEGORIES = ["conciertos", "deportes", "familia", "festivales", "teatro"] as const;
const EVENT_STATUSES = ["draft", "published", "soldout", "archived"] as const;

export const adminEvents = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { items } = await gatewayFetch<{ items: ApiEvent[] }>("/catalog/admin/events", {
      accessToken: context.accessToken,
    });
    // Ocupación por tipo de entrada (inventory); si no responde, el panel igual carga.
    const sold = new Map<string, number>();
    await Promise.all(
      items
        .filter((event) => event.status === "published" || event.status === "soldout")
        .map((event) =>
          gatewayFetch<{ items: { ticketTypeId: string; capacity: number; available: number }[] }>(
            `/inventory/availability/events/${event.id}`,
          )
            .then((result) => {
              for (const item of result.items)
                sold.set(item.ticketTypeId, item.capacity - item.available);
            })
            .catch(() => undefined),
        ),
    );
    return items.map((event) => toAdminEvent(event, sold));
  });

export const adminSaveEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        title: z.string().min(2).max(140),
        artist: z.string().max(140).nullable().optional(),
        category: z.enum(EVENT_CATEGORIES),
        description: z.string().max(4000).nullable().optional(),
        imageId: z.string().uuid().nullable().optional(),
        status: z.enum(EVENT_STATUSES),
        featured: z.boolean(),
        urgencyNote: z.string().max(140).nullable().optional(),
        ageRestriction: z.string().max(60).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const body = {
      title: data.title,
      artist: data.artist ?? null,
      category: data.category,
      description: data.description ?? null,
      imageId: data.imageId ?? null,
      status: data.status,
      featured: data.featured,
      urgencyNote: data.urgencyNote ?? null,
      ageRestriction: data.ageRestriction ?? null,
    };
    const saved = await gatewayFetch<ApiEvent>(
      data.id ? `/catalog/admin/events/${data.id}` : "/catalog/admin/events",
      { method: data.id ? "PUT" : "POST", body, accessToken: context.accessToken },
    );
    return { id: saved.id };
  });

export const adminDeleteEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/events/${data.id}`, {
      method: "DELETE",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

/** Imagen para eventos y productos: el catálogo la valida y re-codifica (media propia). */
export const adminUploadImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error("Adjunta una imagen");
    const file = input.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Adjunta una imagen");
    if (file.size > 8 * 1024 * 1024) throw new Error("La imagen supera los 8 MB");
    return file;
  })
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const form = new FormData();
    form.append("file", data, data.name || "imagen");
    return gatewayFetch<{ id: string; url: string; width: number; height: number }>(
      "/catalog/admin/media",
      { method: "POST", form, accessToken: context.accessToken },
    );
  });

/** Fila virtual del evento (ADR-06): la configuración es de catalog; queue la aplica al instante. */
export const adminSaveQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        eventId: z.string().uuid(),
        enabled: z.boolean(),
        opensAt: z.string().nullable().optional(),
        concurrentSlots: z.number().int().min(1).max(10000),
        windowMinutes: z.number().int().min(1).max(120),
        admitBatchMax: z.number().int().min(1).max(1000),
        waitingMessage: z.string().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/events/${data.eventId}/queue`, {
      method: "PUT",
      accessToken: context.accessToken,
      body: {
        enabled: data.enabled,
        opensAt: data.opensAt ? new Date(data.opensAt).toISOString() : null,
        concurrentSlots: data.concurrentSlots,
        windowMinutes: data.windowMinutes,
        admitBatchMax: data.admitBatchMax,
        waitingMessage: data.waitingMessage || null,
      },
    });
    return { ok: true };
  });

export const adminResetQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ eventId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/queue/admin/events/${data.eventId}/reset`, {
      method: "POST",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

export const adminSaveDate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        eventId: z.string().uuid(),
        venueId: z.string().uuid(),
        startsAt: z.string().min(10),
        doorsAt: z.string().min(10).nullable().optional(),
        onSale: z.boolean(),
        prices: z
          .array(
            z.object({
              sectionId: z.string().uuid(),
              name: z.string().min(1).max(80),
              price: z.number().int().min(0),
              fee: z.number().int().min(0),
              capacity: z.number().int().min(0),
            }),
          )
          .max(30),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const body = {
      venueId: data.venueId,
      startsAt: new Date(data.startsAt).toISOString(),
      doorsAt: data.doorsAt ? new Date(data.doorsAt).toISOString() : null,
      onSale: data.onSale,
      ticketTypes: data.prices.map((price) => ({
        sectionId: price.sectionId,
        name: price.name,
        price: price.price,
        fee: price.fee,
        capacity: price.capacity,
      })),
    };
    const event = await gatewayFetch<ApiEvent>(
      data.id ? `/catalog/admin/dates/${data.id}` : `/catalog/admin/events/${data.eventId}/dates`,
      { method: data.id ? "PUT" : "POST", body, accessToken: context.accessToken },
    );
    return { id: data.id ?? event.dates.at(-1)?.id ?? null };
  });

export const adminDeleteDate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/dates/${data.id}`, {
      method: "DELETE",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

export const adminVenues = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { items } = await gatewayFetch<{ items: ApiVenue[] }>("/catalog/admin/venues", {
      accessToken: context.accessToken,
    });
    return items.map((venue) => ({
      id: venue.id,
      name: venue.name,
      city: venue.city,
      address: venue.address,
      capacity: venue.capacity,
      map_width: venue.map.width,
      map_height: venue.map.height,
      venue_sections: venue.sections.map((section) => ({
        id: section.id,
        name: section.name,
        kind: section.kind,
        capacity: section.capacity,
        sort_order: section.sortOrder,
        shape_x: section.shape.x,
        shape_y: section.shape.y,
        shape_w: section.shape.w,
        shape_h: section.shape.h,
      })),
    }));
  });

export const adminSaveVenue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        name: z.string().min(2).max(120),
        city: z.string().min(2).max(80),
        address: z.string().max(200).nullable().optional(),
        capacity: z.number().int().min(0),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const body = {
      name: data.name,
      city: data.city,
      address: data.address ?? null,
      capacity: data.capacity,
    };
    const venue = await gatewayFetch<ApiVenue>(
      data.id ? `/catalog/admin/venues/${data.id}` : "/catalog/admin/venues",
      { method: data.id ? "PUT" : "POST", body, accessToken: context.accessToken },
    );
    return { id: venue.id };
  });

export const adminSaveSection = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        venueId: z.string().uuid(),
        name: z.string().min(1).max(80),
        kind: z.enum(["seated", "general"]),
        capacity: z.number().int().min(0),
        sortOrder: z.number().int().min(0).max(99),
        x: z.number().min(0),
        y: z.number().min(0),
        w: z.number().min(10),
        h: z.number().min(10),
        seatRows: z.number().int().min(0).max(40).default(0),
        seatsPerRow: z.number().int().min(0).max(40).default(0),
        /** Al editar un sector numerado, solo se regeneran las butacas si se pide. */
        regenerateSeats: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const wantsSeats =
      data.kind === "seated" &&
      data.seatRows > 0 &&
      data.seatsPerRow > 0 &&
      (!data.id || data.regenerateSeats);
    const body = {
      name: data.name,
      kind: data.kind,
      capacity: data.capacity,
      sortOrder: data.sortOrder,
      shape: { x: data.x, y: data.y, w: data.w, h: data.h },
      ...(wantsSeats ? { seatGrid: { rows: data.seatRows, perRow: data.seatsPerRow } } : {}),
    };
    const section = await gatewayFetch<{ id: string }>(
      data.id
        ? `/catalog/admin/sections/${data.id}`
        : `/catalog/admin/venues/${data.venueId}/sections`,
      { method: data.id ? "PUT" : "POST", body, accessToken: context.accessToken },
    );
    return { id: section.id };
  });

export const adminDeleteSection = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/sections/${data.id}`, {
      method: "DELETE",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

export const adminToggleSeat = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z.object({ seatId: z.string().uuid(), blocked: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/seats/${data.seatId}`, {
      method: "PUT",
      body: { blocked: data.blocked },
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

export type AdminProduct = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: string;
  fee: string;
  imageId: string | null;
  imageUrl: string | null;
  eventId: string | null;
  status: "draft" | "active" | "archived";
  maxPerOrder: number;
};

/** Productos (RF03, RF14): `ItemVendible` de tipo `product` en el catálogo. */
export const adminProducts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { items } = await gatewayFetch<{ items: AdminProduct[] }>("/catalog/admin/products", {
      accessToken: context.accessToken,
    });
    return items;
  });

export const adminSaveProduct = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        name: z.string().min(2).max(140),
        description: z.string().max(4000).nullable().optional(),
        sku: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,40}$/, "SKU: letras, números, punto, guion")
          .nullable()
          .optional(),
        price: z.number().int().min(0),
        fee: z.number().int().min(0),
        imageId: z.string().uuid().nullable().optional(),
        eventId: z.string().uuid().nullable().optional(),
        status: z.enum(["draft", "active", "archived"]),
        maxPerOrder: z.number().int().min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const body = {
      name: data.name,
      description: data.description ?? null,
      sku: data.sku ?? null,
      price: data.price,
      fee: data.fee,
      imageId: data.imageId ?? null,
      eventId: data.eventId ?? null,
      status: data.status,
      maxPerOrder: data.maxPerOrder,
    };
    const product = await gatewayFetch<AdminProduct>(
      data.id ? `/catalog/admin/products/${data.id}` : "/catalog/admin/products",
      { method: data.id ? "PUT" : "POST", body, accessToken: context.accessToken },
    );
    return { id: product.id };
  });

export const adminDeleteProduct = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/catalog/admin/products/${data.id}`, {
      method: "DELETE",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

/** Órdenes (orders). */
export const adminOrders = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { items } = await gatewayFetch<{ items: ApiOrder[] }>("/orders/admin/orders", {
      accessToken: context.accessToken,
    });
    return items;
  });

/** Reembolso total de una orden confirmada (payments + inventory devuelve el cupo). */
export const adminRefundOrder = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    return gatewayFetch<ApiOrder>(`/orders/admin/orders/${data.id}/refund`, {
      method: "POST",
      accessToken: context.accessToken,
    });
  });

type ApiPromo = {
  id: string;
  code: string;
  percentOff: number;
  maxUses: number;
  usedCount: number;
  validUntil: string | null;
  active: boolean;
  createdAt: string;
};

export const adminPromos = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { items } = await gatewayFetch<{ items: ApiPromo[] }>("/orders/admin/promos", {
      accessToken: context.accessToken,
    });
    return items.map((promo) => ({
      id: promo.id,
      code: promo.code,
      percent_off: promo.percentOff,
      max_uses: promo.maxUses,
      used_count: promo.usedCount,
      valid_until: promo.validUntil,
      active: promo.active,
      created_at: promo.createdAt,
    }));
  });

export const adminSavePromo = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        code: z.string().min(2).max(40),
        percentOff: z.number().int().min(1).max(100),
        maxUses: z.number().int().min(1).max(100000),
        validUntil: z.string().nullable().optional(),
        active: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const body = {
      code: data.code.toUpperCase(),
      percentOff: data.percentOff,
      maxUses: data.maxUses,
      validUntil: data.validUntil ? new Date(data.validUntil).toISOString() : null,
      active: data.active,
    };
    await gatewayFetch(data.id ? `/orders/admin/promos/${data.id}` : "/orders/admin/promos", {
      method: data.id ? "PUT" : "POST",
      body,
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

export const adminDeletePromo = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/orders/admin/promos/${data.id}`, {
      method: "DELETE",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });

type IdentityUser = {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  status: "active" | "disabled";
};

/** Equipo administrador, desde identity (reemplaza auth.admin.listUsers + user_roles). */
export const adminStaff = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const page = await gatewayFetch<{ items: IdentityUser[] }>(
      "/admin/users?role=admin&limit=100",
      {
        accessToken: context.accessToken,
      },
    );
    return page.items.map((user) => ({
      userId: user.id,
      role: "admin" as const,
      email: user.email,
      fullName: user.fullName || null,
      lastSignInAt: null as string | null,
    }));
  });

export const adminCreateStaff = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(10).max(128),
        fullName: z.string().max(120).optional(),
        role: z.literal("admin"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { gatewayFetch } = await import("./auth/gateway.server");
    const created = await gatewayFetch<IdentityUser>("/admin/users", {
      method: "POST",
      accessToken: context.accessToken,
      body: {
        email: data.email.toLowerCase(),
        password: data.password,
        fullName: data.fullName?.trim() || data.email,
        roles: [data.role],
      },
    });
    return { userId: created.id };
  });

export const adminRemoveStaff = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z.object({ userId: z.string().uuid(), role: z.literal("admin") }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    if (data.userId === context.userId) throw new Error("No puedes quitarte tu propio acceso");
    const { gatewayFetch } = await import("./auth/gateway.server");
    const user = await gatewayFetch<IdentityUser>(`/admin/users/${data.userId}`, {
      accessToken: context.accessToken,
    });
    const roles = user.roles.filter((role) => role !== data.role);
    await gatewayFetch(`/admin/users/${data.userId}/roles`, {
      method: "PUT",
      accessToken: context.accessToken,
      body: { roles: roles.length > 0 ? roles : ["customer"] },
    });
    return { ok: true };
  });
