import type { ServiceClient } from "@shared/commons/http";

/**
 * Lo que orders necesita de otros servicios (contratos en packages/contracts). Interfaces para
 * poder probar la saga sin levantar todo; las implementaciones HTTP van abajo.
 */
export interface ReservationView {
  id: string;
  userId: string;
  status: "ACTIVE" | "SOLD" | "RELEASED" | "EXPIRED";
  eventId: string;
  eventDateId: string;
  ticketTypeId: string;
  quantity: number;
  seatIds: string[];
  expiresAt: string;
  orderId: string | null;
}

export interface InventoryPort {
  get(reservationId: string): Promise<ReservationView | null>;
  /** Todo o nada; falla con CONFLICT `RESERVATION_NOT_ACTIVE` si alguna venció. */
  sell(orderId: string, reservationIds: string[]): Promise<void>;
  release(reservationIds: string[], reason: string): Promise<void>;
  returnSold(orderId: string): Promise<void>;
}

/** Vista de un `ItemVendible` (catalog `POST /v1/items/resolve`). */
export interface SellableItem {
  id: string;
  kind: string;
  name: string;
  unitPrice: string;
  unitFee: string;
  saleable: boolean;
  unsaleableReason: string | null;
  maxPerOrder: number;
  attributes: Record<string, unknown>;
}

export interface CatalogPort {
  resolve(refs: { kind: string; id: string }[]): Promise<SellableItem[]>;
}

export interface PaymentIntentView {
  id: string;
  status: string;
  redirectUrl: string | null;
}

export interface PaymentsPort {
  createIntent(orderId: string): Promise<PaymentIntentView>;
  listByOrder(orderId: string): Promise<{ id: string; status: string }[]>;
  refund(paymentId: string, reason: string, idempotencyKey: string): Promise<void>;
}

export function httpInventory(client: ServiceClient): InventoryPort {
  return {
    async get(id) {
      const response = await client.request<ReservationView>(
        "GET",
        `/internal/reservations/${id}`,
        {
          accept: [404],
        },
      );
      return response.status === 404 ? null : response.body;
    },
    async sell(orderId, reservationIds) {
      await client.request("POST", "/internal/reservations/sell", {
        body: { orderId, reservationIds },
        idempotencyKey: `sell-${orderId}`,
      });
    },
    async release(reservationIds, reason) {
      if (reservationIds.length === 0) return;
      await client.request("POST", "/internal/reservations/release", {
        body: { reservationIds, reason },
        idempotencyKey: `release-${reservationIds[0]}`,
      });
    },
    async returnSold(orderId) {
      await client.request("POST", "/internal/reservations/return", {
        body: { orderId },
        idempotencyKey: `return-${orderId}`,
      });
    },
  };
}

export function httpCatalog(client: ServiceClient): CatalogPort {
  return {
    async resolve(refs) {
      const response = await client.request<{ items: SellableItem[] }>(
        "POST",
        "/v1/items/resolve",
        {
          body: { items: refs },
          // Solo lectura: se puede reintentar sin riesgo.
          idempotencyKey: `resolve-${refs
            .map((ref) => ref.id)
            .join("")
            .slice(0, 100)}`,
        },
      );
      return response.body.items;
    },
  };
}

export function httpPayments(client: ServiceClient): PaymentsPort {
  return {
    async createIntent(orderId) {
      const response = await client.request<PaymentIntentView>("POST", "/internal/payments", {
        body: { orderId },
        // Clave = orden (docs/services/payments.md §7): nunca dos cobros por la misma orden.
        idempotencyKey: `order-${orderId}`,
      });
      return response.body;
    },
    async listByOrder(orderId) {
      const response = await client.request<{ items: { id: string; status: string }[] }>(
        "GET",
        `/internal/payments/by-order/${orderId}`,
      );
      return response.body.items;
    },
    async refund(paymentId, reason, idempotencyKey) {
      await client.request("POST", `/internal/payments/${paymentId}/refunds`, {
        body: { reason },
        idempotencyKey,
      });
    },
  };
}
