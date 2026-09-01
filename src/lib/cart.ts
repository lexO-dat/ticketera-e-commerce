import { useCallback, useEffect, useState } from "react";

export type CartItem = {
  key: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  eventDateId: string;
  startsAt: string;
  venueName: string;
  ticketTypeId: string;
  sectionName: string;
  seatId: string | null;
  seatLabel: string | null;
  quantity: number;
  unitPrice: number;
  unitFee: number;
};

const KEY = "ticketera.cart";
const EVENT = "ticketera:cart";

function read(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CartItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: CartItem[]) {
  window.localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function cartTotals(items: CartItem[]) {
  const subtotal = items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0);
  const fees = items.reduce((acc, i) => acc + i.unitFee * i.quantity, 0);
  const count = items.reduce((acc, i) => acc + i.quantity, 0);
  return { subtotal, fees, count, total: subtotal + fees };
}

export function addToCart(newItems: CartItem[]) {
  const current = read();
  const merged = [...current];
  for (const item of newItems) {
    const existing = merged.findIndex((i) => i.key === item.key);
    if (existing >= 0) {
      const prev = merged[existing]!;
      merged[existing] = { ...prev, quantity: item.seatId ? 1 : prev.quantity + item.quantity };
    } else {
      merged.push(item);
    }
  }
  write(merged);
}

export function removeFromCart(key: string) {
  write(read().filter((i) => i.key !== key));
}

export function setQuantity(key: string, quantity: number) {
  write(
    read().map((i) => (i.key === key ? { ...i, quantity: Math.max(1, Math.min(8, quantity)) } : i)),
  );
}

export function clearCart() {
  write([]);
}

export function useCart() {
  const [items, setItems] = useState<CartItem[]>([]);

  useEffect(() => {
    const sync = () => setItems(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const refresh = useCallback(() => setItems(read()), []);

  return { items, totals: cartTotals(items), refresh };
}
