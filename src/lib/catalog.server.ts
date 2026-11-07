/**
 * Tipos del API de `catalog` (contrato: packages/contracts/openapi/catalog.yaml) y utilidades del
 * BFF mientras dura la migración. Solo servidor.
 */

export type SectionKind = "seated" | "general";

export type ApiTicketType = {
  id: string;
  name: string;
  price: string;
  fee: string;
  capacity: number;
  sectionId: string;
  sectionKind: SectionKind;
  sortOrder: number;
};

export type ApiEventDate = {
  id: string;
  startsAt: string;
  doorsAt: string | null;
  onSale: boolean;
  venue: { id: string; name: string; city: string };
  ticketTypes: ApiTicketType[];
};

export type ApiEventSummary = {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: string;
  description: string | null;
  imageUrl: string | null;
  status: string;
  featured: boolean;
  urgencyNote: string | null;
  ageRestriction: string | null;
  nextDate: string | null;
  city: string | null;
  venueName: string | null;
  minPrice: string | null;
  capacity: number;
  datesCount: number;
};

export type ApiEvent = Omit<
  ApiEventSummary,
  "nextDate" | "city" | "venueName" | "minPrice" | "capacity" | "datesCount"
> & {
  imageId: string | null;
  ownerId: string | null;
  dates: ApiEventDate[];
};

export type ApiSection = {
  id: string;
  venueId: string;
  name: string;
  kind: SectionKind;
  capacity: number;
  sortOrder: number;
  shape: { x: number; y: number; w: number; h: number };
};

export type ApiVenue = {
  id: string;
  name: string;
  city: string;
  address: string | null;
  capacity: number;
  map: { width: number; height: number };
  sections: ApiSection[];
};

export type ApiSeatMap = {
  date: {
    id: string;
    startsAt: string;
    doorsAt: string | null;
    onSale: boolean;
    event: { id: string; slug: string; title: string; status: string };
    venue: { id: string; name: string; city: string; mapWidth: number; mapHeight: number };
  };
  sections: Omit<ApiSection, "venueId">[];
  ticketTypes: ApiTicketType[];
  seats: {
    id: string;
    sectionId: string;
    row: string;
    number: number;
    x: number;
    y: number;
    blocked: boolean;
  }[];
};

/**
 * Lecturas de dominios que todavía viven en Supabase (fila virtual, reservas, órdenes, métricas)
 * hasta sus fases. Si Supabase no está configurado o falla, la página sigue funcionando con el
 * valor por defecto en vez de romperse.
 */
export async function legacy<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  if (!process.env["SUPABASE_URL"]) return fallback;
  try {
    return await read();
  } catch (error) {
    console.error(
      "[legacy] lectura de Supabase falló:",
      error instanceof Error ? error.message : error,
    );
    return fallback;
  }
}
