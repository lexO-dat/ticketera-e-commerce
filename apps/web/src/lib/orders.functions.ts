import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";

/**
 * Carro, checkout y órdenes reales (Fase 5): el microservicio `orders` vía gateway. El carro vive
 * en Redis (sobrevive a recargar y al failover); los precios los recalcula el servidor en el
 * checkout y el cobro lo hace `payments` con el adquirente (webpay-mock).
 */

export type ServerCartItem = {
  key: string;
  kind: string;
  itemId: string;
  quantity: number;
  reservationId?: string;
  eventId?: string;
  eventDateId?: string;
  display?: {
    title: string;
    subtitle?: string;
    eventSlug?: string;
    startsAt?: string;
    venueName?: string;
    seatLabel?: string;
    productSlug?: string;
    imageUrl?: string;
  };
  unitPrice: number;
  unitFee: number;
};

export type ApiOrder = {
  id: string;
  orderCode: string;
  userId: string;
  buyer: { name: string; email: string; phone: string | null; document: string | null };
  subtotal: string;
  fees: string;
  discount: string;
  total: string;
  promoCode: string | null;
  status: "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED";
  cancelReason: string | null;
  paymentId: string | null;
  expiresAt: string;
  createdAt: string;
  confirmedAt: string | null;
  lines: {
    id: string;
    kind: string;
    itemId: string;
    name: string;
    quantity: number;
    unitPrice: string;
    unitFee: string;
    reservationId: string | null;
    eventId: string | null;
    eventDateId: string | null;
    seatIds: string[];
    attributes: Record<string, string | number | boolean | null>;
  }[];
};

const itemSchema = z.object({
  key: z.string().min(1).max(120),
  kind: z.string().regex(/^[a-z_]{1,40}$/),
  itemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(8),
  reservationId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  eventDateId: z.string().uuid().optional(),
  display: z
    .object({
      title: z.string().max(200),
      subtitle: z.string().max(200).optional(),
      eventSlug: z.string().max(100).optional(),
      startsAt: z.string().max(40).optional(),
      venueName: z.string().max(120).optional(),
      seatLabel: z.string().max(80).optional(),
      productSlug: z.string().max(100).optional(),
      imageUrl: z.string().max(300).optional(),
    })
    .optional(),
  unitPrice: z.number().int().min(0),
  unitFee: z.number().int().min(0),
});

/** Carro del usuario; vacío si no hay sesión (el encabezado lo consulta siempre). */
export const getCart = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerCartItem[]> => {
    const { currentAuth } = await import("./auth/session.server");
    const auth = await currentAuth();
    if (!auth) return [];
    const { gatewayFetch } = await import("./auth/gateway.server");
    const cart = await gatewayFetch<{ items: ServerCartItem[] }>("/orders/cart", {
      accessToken: auth.accessToken,
    }).catch(() => ({ items: [] }));
    return cart.items;
  },
);

export const addCartItems = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        replaceEventDateId: z.string().uuid().optional(),
        items: z.array(itemSchema).min(1).max(20),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const cart = await gatewayFetch<{ items: ServerCartItem[] }>("/orders/cart/items", {
      method: "POST",
      body: data,
      accessToken: context.accessToken,
    });
    return cart.items;
  });

/** Quita un ítem; si era una entrada reservada, libera la reserva al instante. */
export const removeCartItem = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ key: z.string().min(1).max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const result = await gatewayFetch<{ removed: ServerCartItem | null; items: ServerCartItem[] }>(
      `/orders/cart/items/${encodeURIComponent(data.key)}`,
      { method: "DELETE", accessToken: context.accessToken },
    );
    if (result.removed?.reservationId) {
      await gatewayFetch(`/inventory/reservations/${result.removed.reservationId}`, {
        method: "DELETE",
        accessToken: context.accessToken,
      }).catch(() => undefined);
    }
    return result.items;
  });

export const validatePromo = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ code: z.string().min(2).max(40) }).parse(input))
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    return gatewayFetch<
      { valid: true; code: string; percentOff: number } | { valid: false; reason: string }
    >("/orders/promos/validate", { method: "POST", body: data, accessToken: context.accessToken });
  });

/**
 * Checkout: crea la orden con montos del servidor y devuelve la URL del formulario del
 * adquirente. La clave de idempotencia la genera la página una vez: un doble clic no crea dos
 * órdenes ni dos cobros.
 */
export const checkout = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        idempotencyKey: z.string().uuid(),
        buyer: z.object({
          name: z.string().min(2).max(120),
          email: z.string().email(),
          phone: z.string().max(40).nullable(),
          document: z.string().max(40).nullable(),
        }),
        promoCode: z.string().max(40).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    return gatewayFetch<{
      orderId: string;
      orderCode: string;
      total: string;
      redirectUrl: string | null;
    }>("/orders/checkout", {
      method: "POST",
      body: { buyer: data.buyer, promoCode: data.promoCode },
      headers: { "idempotency-key": data.idempotencyKey },
      accessToken: context.accessToken,
    });
  });

/** Reabre el pago de una orden pendiente. */
export const payOrder = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ code: z.string().min(4).max(40) }).parse(input))
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    return gatewayFetch<{ orderCode: string; redirectUrl: string | null }>(
      `/orders/orders/${encodeURIComponent(data.code)}/pay`,
      { method: "POST", accessToken: context.accessToken },
    );
  });

export const getOrder = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ code: z.string().min(4).max(40) }).parse(input))
  .handler(async ({ data, context }): Promise<ApiOrder | null> => {
    const { gatewayFetch, GatewayError } = await import("./auth/gateway.server");
    try {
      return await gatewayFetch<ApiOrder>(
        `/orders/orders/${encodeURIComponent(data.code.toUpperCase())}`,
        {
          accessToken: context.accessToken,
        },
      );
    } catch (error) {
      if (error instanceof GatewayError && (error.status === 404 || error.status === 400))
        return null;
      throw error;
    }
  });
