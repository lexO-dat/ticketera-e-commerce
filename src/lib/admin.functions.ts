import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const [
      { data: orders },
      { data: events },
      { data: metrics },
      { data: types },
      { data: queues },
    ] = await Promise.all([
      db
        .from("orders")
        .select("id, order_code, buyer_name, buyer_email, total, status, created_at")
        .order("created_at", { ascending: false })
        .limit(300),
      db.from("events").select("id, title, slug, status, category"),
      db.from("event_metrics").select("event_id, kind, quantity, amount, created_at").limit(5000),
      db.from("ticket_types").select("id, event_date_id, capacity, sold, price, service_fee"),
      db.from("queue_sessions").select("event_id, state"),
    ]);

    const paid = (orders ?? []).filter((o) => o.status === "paid");
    const revenue = paid.reduce((s, o) => s + Number(o.total), 0);
    const ticketsSold = (types ?? []).reduce((s, t) => s + t.sold, 0);
    const capacity = (types ?? []).reduce((s, t) => s + t.capacity, 0);

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
    for (const m of metrics ?? []) {
      funnel[m.kind] = (funnel[m.kind] ?? 0) + m.quantity;
      const entry = perEvent.get(m.event_id) ?? { views: 0, revenue: 0 };
      if (m.kind === "view") entry.views += m.quantity;
      entry.revenue += Number(m.amount);
      perEvent.set(m.event_id, entry);
    }

    const topEvents = (events ?? [])
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
    for (const q of queues ?? []) queueCounts[q.state] = (queueCounts[q.state] ?? 0) + 1;

    return {
      kpis: {
        revenue,
        orders: paid.length,
        ticketsSold,
        capacity,
        occupancy: capacity > 0 ? ticketsSold / capacity : 0,
        avgTicket: paid.length > 0 ? revenue / paid.length : 0,
        publishedEvents: (events ?? []).filter((e) => e.status === "published").length,
      },
      series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
      funnel,
      topEvents,
      queueCounts,
      recentOrders: (orders ?? []).slice(0, 8),
    };
  });

export const adminEvents = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data, error } = await db
      .from("events")
      .select(
        `id, slug, title, artist, category, status, featured, image_url, description, urgency_note, age_restriction,
         event_dates ( id, starts_at, doors_at, on_sale, venue_id, venues ( name, city ),
           ticket_types ( id, name, price, service_fee, capacity, sold, section_id ) ),
         queue_config ( enabled, concurrent_slots, window_minutes, waiting_message, simulated_queue_size )`,
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const adminSaveEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        title: z.string().min(2).max(140),
        artist: z.string().max(140).nullable().optional(),
        category: z.enum(["conciertos", "deportes", "familia", "festivales", "teatro"]),
        description: z.string().max(4000).nullable().optional(),
        imageUrl: z.string().max(500).nullable().optional(),
        status: z.enum(["draft", "published", "soldout", "archived"]),
        featured: z.boolean(),
        urgencyNote: z.string().max(140).nullable().optional(),
        ageRestriction: z.string().max(60).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin, slugify } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const payload = {
      title: data.title,
      artist: data.artist ?? null,
      category: data.category,
      description: data.description ?? null,
      image_url: data.imageUrl ?? null,
      status: data.status,
      featured: data.featured,
      urgency_note: data.urgencyNote ?? null,
      age_restriction: data.ageRestriction ?? null,
    };

    if (data.id) {
      const { error } = await db.from("events").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }

    const slug = `${slugify(data.title)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data: created, error } = await db
      .from("events")
      .insert({ ...payload, slug })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message ?? "No se pudo crear el evento");
    await db.from("queue_config").insert({ event_id: created.id });
    return { id: created.id };
  });

export const adminDeleteEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("events").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminSaveQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        eventId: z.string().uuid(),
        enabled: z.boolean(),
        concurrentSlots: z.number().int().min(1).max(5000),
        windowMinutes: z.number().int().min(1).max(120),
        simulatedQueueSize: z.number().int().min(0).max(100000),
        waitingMessage: z.string().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("queue_config").upsert(
      {
        event_id: data.eventId,
        enabled: data.enabled,
        concurrent_slots: data.concurrentSlots,
        window_minutes: data.windowMinutes,
        simulated_queue_size: data.simulatedQueueSize,
        waiting_message: data.waitingMessage ?? null,
      },
      { onConflict: "event_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminResetQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ eventId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    await db.from("queue_sessions").delete().eq("event_id", data.eventId);
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
              price: z.number().min(0),
              fee: z.number().min(0),
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
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const payload = {
      event_id: data.eventId,
      venue_id: data.venueId,
      starts_at: new Date(data.startsAt).toISOString(),
      doors_at: data.doorsAt ? new Date(data.doorsAt).toISOString() : null,
      on_sale: data.onSale,
    };

    let dateId = data.id ?? null;
    if (dateId) {
      const { error } = await db.from("event_dates").update(payload).eq("id", dateId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await db
        .from("event_dates")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message ?? "No se pudo crear la fecha");
      dateId = created.id;
    }

    const { data: existing } = await db
      .from("ticket_types")
      .select("id, section_id")
      .eq("event_date_id", dateId);

    for (const price of data.prices) {
      const match = (existing ?? []).find((t) => t.section_id === price.sectionId);
      const row = {
        event_date_id: dateId,
        section_id: price.sectionId,
        name: price.name,
        price: price.price,
        service_fee: price.fee,
        capacity: price.capacity,
      };
      if (match) await db.from("ticket_types").update(row).eq("id", match.id);
      else await db.from("ticket_types").insert(row);
    }

    return { id: dateId };
  });

export const adminDeleteDate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("event_dates").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminVenues = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data, error } = await db
      .from("venues")
      .select(
        `id, name, city, address, capacity, map_width, map_height,
         venue_sections ( id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h )`,
      )
      .order("name");
    if (error) throw new Error(error.message);
    return data ?? [];
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
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const payload = {
      name: data.name,
      city: data.city,
      address: data.address ?? null,
      capacity: data.capacity,
    };
    if (data.id) {
      const { error } = await db.from("venues").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: created, error } = await db.from("venues").insert(payload).select("id").single();
    if (error || !created) throw new Error(error?.message ?? "No se pudo crear el recinto");
    return { id: created.id };
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
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin, seatGrid } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const payload = {
      venue_id: data.venueId,
      name: data.name,
      kind: data.kind,
      capacity: data.capacity,
      sort_order: data.sortOrder,
      shape_x: data.x,
      shape_y: data.y,
      shape_w: data.w,
      shape_h: data.h,
    };

    let sectionId = data.id ?? null;
    if (sectionId) {
      const { error } = await db.from("venue_sections").update(payload).eq("id", sectionId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await db
        .from("venue_sections")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message ?? "No se pudo crear el sector");
      sectionId = created.id;
    }

    if (data.kind === "seated" && data.seatRows > 0 && data.seatsPerRow > 0) {
      await db.from("venue_seats").delete().eq("section_id", sectionId);
      const seats = seatGrid({
        rows: data.seatRows,
        perRow: data.seatsPerRow,
        x: data.x + 12,
        y: data.y + 12,
        w: Math.max(10, data.w - 24),
        h: Math.max(10, data.h - 24),
      }).map((seat) => ({ ...seat, section_id: sectionId }));
      const { error } = await db.from("venue_seats").insert(seats);
      if (error) throw new Error(error.message);
      await db.from("venue_sections").update({ capacity: seats.length }).eq("id", sectionId);
    }

    return { id: sectionId };
  });

export const adminDeleteSection = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("venue_sections").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
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
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db
      .from("venue_seats")
      .update({ blocked: data.blocked })
      .eq("id", data.seatId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminOrders = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data, error } = await db
      .from("orders")
      .select(
        `id, order_code, buyer_name, buyer_email, buyer_phone, total, subtotal, fees, discount, promo_code, status, created_at,
         order_items ( id, quantity, unit_price, unit_fee,
           event_dates ( starts_at, events ( title ), venues ( name, city ) ),
           ticket_types ( name ) ),
         tickets ( id, ticket_code, checked_in_at )`,
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const adminUpdateOrderStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["pending", "paid", "refunded", "cancelled"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("orders").update({ status: data.status }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminPromos = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data, error } = await db
      .from("promo_codes")
      .select("id, code, percent_off, max_uses, used_count, valid_until, active, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
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
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const payload = {
      code: data.code.toUpperCase(),
      percent_off: data.percentOff,
      max_uses: data.maxUses,
      valid_until: data.validUntil ? new Date(data.validUntil).toISOString() : null,
      active: data.active,
    };
    if (data.id) {
      const { error } = await db.from("promo_codes").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    const { error } = await db.from("promo_codes").insert(payload);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminDeletePromo = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./admin.server");
    assertAdmin(context.roles);
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { error } = await db.from("promo_codes").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
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
    const page = await gatewayFetch<{ items: IdentityUser[] }>("/admin/users?role=admin&limit=100", {
      accessToken: context.accessToken,
    });
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
