import { AppError } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";
import { z } from "zod";

/**
 * Carrito en Redis replicado (ADR-01): sobrevive al failover de una réplica y a recargar la página.
 * Los precios que guarda son solo informativos: el checkout los vuelve a calcular en el servidor.
 */
export const cartItemSchema = z.strictObject({
  key: z.string().min(1).max(120),
  kind: z.string().regex(/^[a-z_]{1,40}$/),
  itemId: z.guid(),
  quantity: z.int().min(1).max(8),
  /** Entradas: la reserva exclusiva de inventory que respalda la línea. */
  reservationId: z.guid().optional(),
  eventId: z.guid().optional(),
  eventDateId: z.guid().optional(),
  display: z
    .strictObject({
      title: z.string().max(200),
      subtitle: z.string().max(200).optional(),
      eventSlug: z.string().max(100).optional(),
      startsAt: z.string().max(40).optional(),
      venueName: z.string().max(120).optional(),
      seatLabel: z.string().max(80).optional(),
    })
    .optional(),
  unitPrice: z.int().min(0),
  unitFee: z.int().min(0),
});

export type CartItem = z.infer<typeof cartItemSchema>;

const MAX_ITEMS = 20;
const key = (userId: string) => `orders:cart:${userId}`;

export function createCart(redis: Redis, ttlSeconds: number) {
  async function read(userId: string): Promise<CartItem[]> {
    const raw = await redis.get(key(userId));
    return raw ? (JSON.parse(raw) as CartItem[]) : [];
  }
  async function write(userId: string, items: CartItem[]) {
    if (items.length === 0) await redis.del(key(userId));
    else await redis.set(key(userId), JSON.stringify(items), "EX", ttlSeconds);
    return items;
  }

  return {
    get: read,

    /** Agrega o reemplaza ítems; con `replaceEventDateId` primero quita los de esa función. */
    async add(userId: string, items: CartItem[], replaceEventDateId?: string): Promise<CartItem[]> {
      let current = await read(userId);
      if (replaceEventDateId)
        current = current.filter((item) => item.eventDateId !== replaceEventDateId);
      for (const item of items) {
        current = current.filter((existing) => existing.key !== item.key);
        current.push(item);
      }
      if (current.length > MAX_ITEMS) {
        throw AppError.conflict("CART_FULL", `Máximo ${MAX_ITEMS} ítems en el carro`);
      }
      return write(userId, current);
    },

    async remove(
      userId: string,
      itemKey: string,
    ): Promise<{ removed: CartItem | undefined; items: CartItem[] }> {
      const current = await read(userId);
      const removed = current.find((item) => item.key === itemKey);
      return {
        removed,
        items: await write(
          userId,
          current.filter((item) => item.key !== itemKey),
        ),
      };
    },

    async clear(userId: string): Promise<void> {
      await redis.del(key(userId));
    },
  };
}

export type Cart = ReturnType<typeof createCart>;
