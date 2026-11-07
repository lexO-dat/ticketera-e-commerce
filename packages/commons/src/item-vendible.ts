import type { CLP } from "./money.js";

/**
 * Punto de extensión del catálogo (ADR-05, ASR05). Entradas (`ticket_type`) y productos
 * (`product`) lo implementan; `orders` y `payments` solo conocen esta interfaz, así un nuevo tipo
 * de ítem no obliga a modificar esos servicios.
 *
 * En el modelo de la arquitectura se llama `ItemVendible`.
 */
export interface SellableItem {
  readonly id: string;
  /** Tipo de ítem, p. ej. `ticket_type`, `product`. Abierto: un tipo nuevo no requiere cambios aquí. */
  readonly kind: string;
  readonly name: string;
  /** Precio unitario en CLP. */
  price(): CLP;
  /** Cargo por servicio unitario en CLP (0 si no aplica). */
  fee(): CLP;
  /** Unidades disponibles ahora (puede venir de caché; la verdad la tiene `inventory`). */
  availability(): Promise<number>;
  /** Reserva exclusiva por `ttlSeconds` (ADR-03: 10 min por defecto). */
  reserve(request: ReservationRequest): Promise<Reservation>;
}

export type ItemVendible = SellableItem;

/** ADR-03: duración de la reserva exclusiva. */
export const DEFAULT_RESERVATION_TTL_SECONDS = 10 * 60;

export interface ReservationRequest {
  quantity: number;
  holderId: string;
  ttlSeconds: number;
  /** Para ítems con ubicación (butacas numeradas). */
  unitIds?: string[];
}

export const ReservationStatus = {
  ACTIVE: "ACTIVE",
  SOLD: "SOLD",
  RELEASED: "RELEASED",
  EXPIRED: "EXPIRED",
} as const;

export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

export interface Reservation {
  id: string;
  itemId: string;
  itemKind: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: Date;
}

/** Línea que `orders` recibe de cualquier `SellableItem`: basta para cobrar sin conocer su tipo. */
export interface SellableLine {
  itemId: string;
  itemKind: string;
  name: string;
  quantity: number;
  unitPrice: CLP;
  unitFee: CLP;
  reservationId?: string;
}

/** Registro de implementaciones por `kind`; cada módulo registra la suya al arrancar. */
export class SellableItemRegistry<TSource = unknown> {
  private readonly factories = new Map<string, (source: TSource) => SellableItem>();

  register(kind: string, factory: (source: TSource) => SellableItem): void {
    if (this.factories.has(kind)) throw new Error(`Tipo de ítem ya registrado: ${kind}`);
    this.factories.set(kind, factory);
  }

  create(kind: string, source: TSource): SellableItem {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`Tipo de ítem desconocido: ${kind}`);
    return factory(source);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }
}
