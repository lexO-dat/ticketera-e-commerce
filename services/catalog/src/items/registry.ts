import type { Queryable } from "@shared/commons/db";
import { money } from "../shared.js";

/**
 * Vista de un `ItemVendible` (ADR-05, ASR05) tal como la publica el catálogo: lo mínimo para que
 * `orders` arme y cobre una línea **sin conocer el tipo de ítem**. Precios y cargos salen siempre
 * de aquí (servidor), nunca del cliente. La disponibilidad y la reserva son de `inventory`.
 */
export interface SellableItemSnapshot {
  id: string;
  kind: string;
  name: string;
  unitPrice: string;
  unitFee: string;
  /** Si hoy se puede vender (publicado, a la venta, fecha futura…). */
  saleable: boolean;
  /** Motivo estable cuando `saleable` es false. */
  unsaleableReason: string | null;
  /** Unidades publicadas (techo de inventory); null si no aplica. */
  capacity: number | null;
  maxPerOrder: number;
  /** Datos propios del tipo (p. ej. fecha y sector de una entrada). */
  attributes: Record<string, unknown>;
}

/**
 * Fuente de ítems de un `kind`. Un tipo nuevo de producto se agrega registrando otra fuente al
 * arrancar (`registry.register(...)`), sin tocar rutas, `orders` ni `payments`.
 */
export interface SellableItemSource {
  readonly kind: string;
  resolve(db: Queryable, ids: string[]): Promise<SellableItemSnapshot[]>;
}

export class SellableItemCatalog {
  private readonly sources = new Map<string, SellableItemSource>();

  register(source: SellableItemSource): this {
    if (this.sources.has(source.kind))
      throw new Error(`Tipo de ítem ya registrado: ${source.kind}`);
    this.sources.set(source.kind, source);
    return this;
  }

  kinds(): string[] {
    return [...this.sources.keys()];
  }

  has(kind: string): boolean {
    return this.sources.has(kind);
  }

  /** Resuelve referencias `{kind, id}`; las que no existen se omiten (el llamador decide). */
  async resolve(
    db: Queryable,
    refs: { kind: string; id: string }[],
  ): Promise<SellableItemSnapshot[]> {
    const byKind = new Map<string, Set<string>>();
    for (const ref of refs) {
      const ids = byKind.get(ref.kind) ?? new Set<string>();
      ids.add(ref.id);
      byKind.set(ref.kind, ids);
    }
    const results = await Promise.all(
      [...byKind].map(([kind, ids]) => {
        const source = this.sources.get(kind);
        return source ? source.resolve(db, [...ids]) : Promise.resolve([]);
      }),
    );
    return results.flat();
  }
}

/** Máximo de entradas por compra (como el prototipo). */
const MAX_TICKETS_PER_ORDER = 8;

export const ticketTypeSource: SellableItemSource = {
  kind: "ticket_type",
  async resolve(db, ids) {
    const result = await db.query<{
      id: string;
      name: string;
      price: bigint;
      service_fee: bigint;
      capacity: number;
      section_id: string;
      section_name: string;
      section_kind: "seated" | "general";
      event_date_id: string;
      starts_at: Date;
      on_sale: boolean;
      event_id: string;
      event_title: string;
      event_status: string;
      venue_id: string;
      venue_name: string;
    }>(
      `select t.id, t.name, t.price, t.service_fee, t.capacity,
              s.id as section_id, s.name as section_name, s.kind as section_kind,
              d.id as event_date_id, d.starts_at, d.on_sale,
              e.id as event_id, e.title as event_title, e.status as event_status,
              v.id as venue_id, v.name as venue_name
       from ticket_types t
       join venue_sections s on s.id = t.section_id
       join event_dates d on d.id = t.event_date_id
       join events e on e.id = d.event_id
       join venues v on v.id = d.venue_id
       where t.id = any($1::uuid[])`,
      [ids],
    );
    const now = Date.now();
    return result.rows.map((row) => {
      const reason =
        row.event_status !== "published"
          ? row.event_status === "soldout"
            ? "EVENT_SOLD_OUT"
            : "EVENT_NOT_PUBLISHED"
          : !row.on_sale
            ? "DATE_NOT_ON_SALE"
            : row.starts_at.getTime() <= now
              ? "DATE_ALREADY_STARTED"
              : row.capacity === 0
                ? "NO_CAPACITY"
                : null;
      return {
        id: row.id,
        kind: "ticket_type",
        name: `${row.event_title} — ${row.name}`,
        unitPrice: money(row.price),
        unitFee: money(row.service_fee),
        saleable: reason === null,
        unsaleableReason: reason,
        capacity: row.capacity,
        maxPerOrder: MAX_TICKETS_PER_ORDER,
        attributes: {
          eventId: row.event_id,
          eventDateId: row.event_date_id,
          startsAt: row.starts_at.toISOString(),
          venueId: row.venue_id,
          venueName: row.venue_name,
          sectionId: row.section_id,
          sectionName: row.section_name,
          seated: row.section_kind === "seated",
        },
      };
    });
  },
};

export const productSource: SellableItemSource = {
  kind: "product",
  async resolve(db, ids) {
    const result = await db.query<{
      id: string;
      name: string;
      sku: string | null;
      price: bigint;
      service_fee: bigint;
      status: string;
      max_per_order: number;
      event_id: string | null;
    }>(
      `select id, name, sku, price, service_fee, status, max_per_order, event_id
       from products where id = any($1::uuid[])`,
      [ids],
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: "product",
      name: row.name,
      unitPrice: money(row.price),
      unitFee: money(row.service_fee),
      saleable: row.status === "active",
      unsaleableReason: row.status === "active" ? null : "PRODUCT_NOT_ACTIVE",
      // El stock físico lo administra inventory (Fase 4).
      capacity: null,
      maxPerOrder: row.max_per_order,
      attributes: { sku: row.sku, eventId: row.event_id },
    }));
  },
};

export function defaultSellableCatalog(): SellableItemCatalog {
  return new SellableItemCatalog().register(ticketTypeSource).register(productSource);
}
