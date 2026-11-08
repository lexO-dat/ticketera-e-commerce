import { useCallback, useEffect, useState } from "react";

import { addCartItems, getCart, removeCartItem, type ServerCartItem } from "@/lib/orders.functions";

/**
 * Carro del comprador. Vive en el servidor (orders, Redis replicado — ADR-01): recargar la página o
 * cambiar de réplica no lo pierde. Cada línea de entradas está respaldada por una reserva real de
 * inventory; los precios que muestra son informativos (el checkout los recalcula).
 */
export type CartItem = {
  key: string;
  kind: string;
  itemId: string;
  reservationId: string | null;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  eventDateId: string;
  startsAt: string;
  venueName: string;
  sectionName: string;
  seatLabel: string | null;
  /** Productos de la tienda: ficha y foto (las entradas no los usan). */
  productSlug: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
  unitFee: number;
};

const EVENT = "ticketera:cart";

function fromServer(item: ServerCartItem): CartItem {
  return {
    key: item.key,
    kind: item.kind,
    itemId: item.itemId,
    reservationId: item.reservationId ?? null,
    eventId: item.eventId ?? "",
    eventSlug: item.display?.eventSlug ?? "",
    eventTitle: item.display?.title ?? "",
    eventDateId: item.eventDateId ?? "",
    startsAt: item.display?.startsAt ?? "",
    venueName: item.display?.venueName ?? "",
    sectionName: item.display?.subtitle ?? "",
    seatLabel: item.display?.seatLabel ?? null,
    productSlug: item.display?.productSlug ?? null,
    imageUrl: item.display?.imageUrl ?? null,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    unitFee: item.unitFee,
  };
}

function toServer(item: CartItem): ServerCartItem {
  return {
    key: item.key,
    kind: item.kind,
    itemId: item.itemId,
    quantity: item.quantity,
    ...(item.reservationId ? { reservationId: item.reservationId } : {}),
    ...(item.eventId ? { eventId: item.eventId } : {}),
    ...(item.eventDateId ? { eventDateId: item.eventDateId } : {}),
    display: {
      title: item.eventTitle,
      subtitle: item.sectionName,
      ...(item.eventSlug ? { eventSlug: item.eventSlug } : {}),
      ...(item.startsAt ? { startsAt: item.startsAt } : {}),
      ...(item.venueName ? { venueName: item.venueName } : {}),
      ...(item.seatLabel ? { seatLabel: item.seatLabel } : {}),
      ...(item.productSlug ? { productSlug: item.productSlug } : {}),
      ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    },
    unitPrice: item.unitPrice,
    unitFee: item.unitFee,
  };
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Línea de un producto de la tienda (la clave es estable: volver a agregarlo cambia la cantidad). */
export function productCartItem(
  product: {
    id: string;
    slug: string;
    name: string;
    price: number;
    fee: number;
    imageUrl: string | null;
    eventId: string | null;
  },
  quantity: number,
): CartItem {
  return {
    key: `product:${product.id}`,
    kind: "product",
    itemId: product.id,
    reservationId: null,
    // Sin evento ni función: un producto no pasa por la fila ni por inventory.
    eventId: "",
    eventSlug: "",
    eventTitle: product.name,
    eventDateId: "",
    startsAt: "",
    venueName: "",
    sectionName: "Tienda",
    seatLabel: null,
    productSlug: product.slug,
    imageUrl: product.imageUrl,
    quantity,
    unitPrice: product.price,
    unitFee: product.fee,
  };
}

export const isProduct = (item: CartItem) => item.kind === "product";

export function cartTotals(items: CartItem[]) {
  const subtotal = items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0);
  const fees = items.reduce((acc, i) => acc + i.unitFee * i.quantity, 0);
  const count = items.reduce((acc, i) => acc + i.quantity, 0);
  return { subtotal, fees, count, total: subtotal + fees };
}

/** Agrega líneas; con `replaceEventDateId` reemplaza las de esa función (nueva selección). */
export async function addToCart(items: CartItem[], replaceEventDateId?: string) {
  await addCartItems({
    data: { items: items.map(toServer), ...(replaceEventDateId ? { replaceEventDateId } : {}) },
  });
  notify();
}

/** Quita la línea y libera su reserva. */
export async function removeFromCart(key: string) {
  await removeCartItem({ data: { key } });
  notify();
}

/** El checkout ya vació el carro en el servidor; solo se refresca la vista. */
export function clearCart() {
  notify();
}

export function useCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    getCart()
      .then((server) => setItems(server.map(fromServer)))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(EVENT, refresh);
    return () => window.removeEventListener(EVENT, refresh);
  }, [refresh]);

  return { items, totals: cartTotals(items), refresh, loaded };
}
