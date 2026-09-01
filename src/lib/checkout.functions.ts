import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const HOLD_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function code(prefix: string, length: number) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}${out}`;
}

export const holdSeats = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        eventDateId: z.string().uuid(),
        seatIds: z.array(z.string().uuid()).max(8),
        sessionToken: z.string().min(6).max(80),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const nowIso = new Date().toISOString();
    const expires = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();

    // Drop this session's previous, unsold holds for the date.
    await db
      .from("seat_holds")
      .delete()
      .eq("event_date_id", data.eventDateId)
      .eq("session_token", data.sessionToken)
      .eq("sold", false);

    // Clear expired holds so freed seats can be taken again.
    await db
      .from("seat_holds")
      .delete()
      .eq("event_date_id", data.eventDateId)
      .eq("sold", false)
      .lt("expires_at", nowIso);

    if (data.seatIds.length === 0) return { held: [], conflicts: [], expiresAt: expires };

    const held: string[] = [];
    const conflicts: string[] = [];
    for (const seatId of data.seatIds) {
      const { error } = await db.from("seat_holds").insert({
        event_date_id: data.eventDateId,
        seat_id: seatId,
        session_token: data.sessionToken,
        expires_at: expires,
      });
      if (error) conflicts.push(seatId);
      else held.push(seatId);
    }
    return { held, conflicts, expiresAt: expires };
  });

export const releaseSeats = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ sessionToken: z.string().min(6).max(80) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    await db
      .from("seat_holds")
      .delete()
      .eq("session_token", data.sessionToken)
      .eq("sold", false);
    return { ok: true };
  });

export const validatePromo = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ code: z.string().min(2).max(40) }).parse(input))
  .handler(async ({ data }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data: promo } = await db
      .from("promo_codes")
      .select("code, percent_off, max_uses, used_count, valid_until, active")
      .eq("code", data.code.toUpperCase())
      .maybeSingle();

    if (!promo || !promo.active) return { valid: false as const, reason: "Código no válido" };
    if (promo.used_count >= promo.max_uses)
      return { valid: false as const, reason: "Código agotado" };
    if (promo.valid_until && new Date(promo.valid_until).getTime() < Date.now())
      return { valid: false as const, reason: "Código expirado" };

    return { valid: true as const, code: promo.code, percentOff: promo.percent_off };
  });

const orderItemSchema = z.object({
  eventId: z.string().uuid(),
  eventDateId: z.string().uuid(),
  ticketTypeId: z.string().uuid(),
  seatId: z.string().uuid().nullable(),
  quantity: z.number().int().min(1).max(8),
});

export const createOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        buyerName: z.string().min(2).max(120),
        buyerEmail: z.string().email(),
        buyerPhone: z.string().max(40).optional(),
        buyerDocument: z.string().max(40).optional(),
        promoCode: z.string().max(40).nullable().optional(),
        sessionToken: z.string().min(6).max(80),
        items: z.array(orderItemSchema).min(1).max(20),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const ticketTypeIds = [...new Set(data.items.map((i) => i.ticketTypeId))];
    const { data: types, error: typesError } = await db
      .from("ticket_types")
      .select("id, price, service_fee, capacity, sold, event_date_id")
      .in("id", ticketTypeIds);
    if (typesError) throw new Error(typesError.message);

    let subtotal = 0;
    let fees = 0;
    const priced = data.items.map((item) => {
      const type = (types ?? []).find((t) => t.id === item.ticketTypeId);
      if (!type) throw new Error("Tipo de ticket inexistente");
      const price = Number(type.price);
      const fee = Number(type.service_fee);
      subtotal += price * item.quantity;
      fees += fee * item.quantity;
      return { ...item, price, fee };
    });

    let discount = 0;
    let promoCode: string | null = null;
    if (data.promoCode) {
      const { data: promo } = await db
        .from("promo_codes")
        .select("code, percent_off, max_uses, used_count, valid_until, active")
        .eq("code", data.promoCode.toUpperCase())
        .maybeSingle();
      const usable =
        promo &&
        promo.active &&
        promo.used_count < promo.max_uses &&
        (!promo.valid_until || new Date(promo.valid_until).getTime() > Date.now());
      if (usable && promo) {
        discount = Math.round((subtotal * promo.percent_off) / 100);
        promoCode = promo.code;
        await db
          .from("promo_codes")
          .update({ used_count: promo.used_count + 1 })
          .eq("code", promo.code);
      }
    }

    const total = subtotal + fees - discount;
    const orderCode = code("TK", 8);

    const { data: order, error: orderError } = await db
      .from("orders")
      .insert({
        order_code: orderCode,
        user_id: context.userId,
        buyer_name: data.buyerName,
        buyer_email: data.buyerEmail.toLowerCase(),
        buyer_phone: data.buyerPhone ?? null,
        buyer_document: data.buyerDocument ?? null,
        subtotal,
        fees,
        discount,
        total,
        promo_code: promoCode,
        status: "paid",
      })
      .select("id, order_code")
      .single();
    if (orderError || !order) throw new Error(orderError?.message ?? "No se pudo crear la orden");

    for (const item of priced) {
      const { data: line, error: lineError } = await db
        .from("order_items")
        .insert({
          order_id: order.id,
          event_date_id: item.eventDateId,
          ticket_type_id: item.ticketTypeId,
          seat_id: item.seatId,
          quantity: item.quantity,
          unit_price: item.price,
          unit_fee: item.fee,
        })
        .select("id")
        .single();
      if (lineError || !line) throw new Error(lineError?.message ?? "No se pudo crear el detalle");

      const tickets = Array.from({ length: item.quantity }, () => ({
        order_id: order.id,
        order_item_id: line.id,
        ticket_code: code("T-", 10),
        attendee_name: data.buyerName,
      }));
      await db.from("tickets").insert(tickets);

      const type = (types ?? []).find((t) => t.id === item.ticketTypeId);
      if (type) {
        await db
          .from("ticket_types")
          .update({ sold: type.sold + item.quantity })
          .eq("id", type.id);
      }

      if (item.seatId) {
        await db
          .from("seat_holds")
          .update({ sold: true })
          .eq("event_date_id", item.eventDateId)
          .eq("seat_id", item.seatId);
      }
    }

    const byEvent = new Map<string, number>();
    for (const item of priced) {
      byEvent.set(
        item.eventId,
        (byEvent.get(item.eventId) ?? 0) + (item.price + item.fee) * item.quantity,
      );
    }
    for (const [eventId, amount] of byEvent) {
      await db
        .from("event_metrics")
        .insert({ event_id: eventId, kind: "purchase", quantity: 1, amount });
    }

    return { orderCode: order.order_code };
  });

export const getOrder = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ code: z.string().min(4).max(40) }).parse(input))
  .handler(async ({ data }) => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();
    const { data: order } = await db
      .from("orders")
      .select(
        `id, order_code, buyer_name, buyer_email, subtotal, fees, discount, total, promo_code, status, created_at,
         order_items ( id, quantity, unit_price, unit_fee, seat_id,
           event_dates ( id, starts_at, events ( title, slug ), venues ( name, city ) ),
           ticket_types ( name ),
           venue_seats ( row_label, seat_number ) ),
         tickets ( id, ticket_code, order_item_id, attendee_name )`,
      )
      .eq("order_code", data.code.toUpperCase())
      .maybeSingle();
    return order ?? null;
  });
