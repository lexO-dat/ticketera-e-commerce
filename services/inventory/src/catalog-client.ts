import { AppError, CircuitBreaker, type Logger, retry } from "@shared/commons";

/** Lo que inventory necesita de catalog (contrato: openapi/catalog.yaml). */
export interface CatalogEvent {
  id: string;
  status: string;
  queue: { enabled: boolean };
  dates: {
    id: string;
    startsAt: string;
    onSale: boolean;
    ticketTypes: {
      id: string;
      sectionId: string;
      sectionKind: "seated" | "general";
      capacity: number;
    }[];
  }[];
}

export interface CatalogSeat {
  id: string;
  sectionId: string;
  blocked: boolean;
}

export interface CatalogClient {
  /** null si el evento no existe o no es público. */
  eventById(eventId: string): Promise<CatalogEvent | null>;
  /** Evento al que pertenece un tipo de entrada (vía ItemVendible). */
  eventIdForTicketType(ticketTypeId: string): Promise<string | null>;
  seats(eventDateId: string): Promise<Map<string, CatalogSeat>>;
}

const SEAT_CACHE_MS = 10_000;

/**
 * Cliente HTTP de catalog con timeout, reintentos con backoff + jitter y circuit breaker
 * (AGENTS §8). Las butacas de una fecha se cachean unos segundos en memoria.
 */
export function createCatalogClient(options: {
  baseUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): CatalogClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const breaker = new CircuitBreaker({
    name: "catalog",
    failureThreshold: 5,
    resetTimeoutMs: 10_000,
  });
  const seatCache = new Map<string, { at: number; seats: Map<string, CatalogSeat> }>();

  async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      return await breaker.execute(() =>
        retry(
          async () => {
            const response = await fetchImpl(new URL(path, options.baseUrl), {
              ...init,
              headers: { accept: "application/json", ...(init?.headers ?? {}) },
              signal: AbortSignal.timeout(3_000),
            });
            if (response.status === 404 || response.status === 400) return null;
            if (!response.ok) throw new Error(`catalog respondió ${response.status}`);
            return (await response.json()) as T;
          },
          { attempts: 3, baseDelayMs: 50, maxDelayMs: 500 },
        ),
      );
    } catch (error) {
      options.logger.warn({ err: error, path }, "catalog no disponible");
      throw AppError.unavailable("El catálogo no está disponible; intenta en un momento", 5);
    }
  }

  return {
    eventById: (eventId) => request<CatalogEvent>(`/v1/events/by-id/${eventId}`),

    async eventIdForTicketType(ticketTypeId) {
      const result = await request<{ items: { attributes: { eventId?: string } }[] }>(
        "/v1/items/resolve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ kind: "ticket_type", id: ticketTypeId }] }),
        },
      );
      return result?.items[0]?.attributes.eventId ?? null;
    },

    async seats(eventDateId) {
      const cached = seatCache.get(eventDateId);
      if (cached && Date.now() - cached.at < SEAT_CACHE_MS) return cached.seats;
      const map = await request<{ seats: CatalogSeat[] }>(`/v1/dates/${eventDateId}/seat-map`);
      const seats = new Map((map?.seats ?? []).map((seat) => [seat.id, seat]));
      seatCache.set(eventDateId, { at: Date.now(), seats });
      return seats;
    },
  };
}
