import { AppError, type CLP, createEvent, newId } from "@shared/commons";
import { type Pool, type Queryable, enqueueOutbox, withTransaction } from "@shared/commons/db";
import type { ReadCache } from "../cache.js";
import type { MediaService } from "../media/service.js";
import {
  type Actor,
  assertCanManage,
  isAdmin,
  isUniqueViolation,
  money,
  toIso,
  uniqueSlug,
} from "../shared.js";
import type { SectionKind } from "../venues/service.js";

export const EVENT_CATEGORIES = [
  "conciertos",
  "teatro",
  "festivales",
  "deportes",
  "familia",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_STATUSES = ["draft", "published", "soldout", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Estados visibles al público (como la política RLS "events public read" del prototipo). */
const PUBLIC_STATUSES: readonly EventStatus[] = ["published", "soldout"];

export interface TicketTypeDto {
  id: string;
  name: string;
  price: string;
  fee: string;
  capacity: number;
  sectionId: string;
  sectionKind: SectionKind;
  sortOrder: number;
}

export interface EventDateDto {
  id: string;
  startsAt: string;
  doorsAt: string | null;
  onSale: boolean;
  venue: { id: string; name: string; city: string };
  ticketTypes: TicketTypeDto[];
}

export interface EventDto {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: EventCategory;
  description: string | null;
  imageId: string | null;
  imageUrl: string | null;
  status: EventStatus;
  featured: boolean;
  urgencyNote: string | null;
  ageRestriction: string | null;
  ownerId: string | null;
  queue: QueueSettingsDto;
  dates: EventDateDto[];
}

/** Fila virtual del evento (ADR-06): catalog es dueño de la configuración; queue la aplica. */
export interface QueueSettingsDto {
  enabled: boolean;
  /** Apertura de la venta: antes, los turnos quedan en prefila (se aleatorizan al abrir). */
  opensAt: string | null;
  concurrentSlots: number;
  windowMinutes: number;
  admitBatchMax: number;
  waitingMessage: string | null;
}

export interface QueueSettingsInput {
  enabled: boolean;
  opensAt: Date | null;
  concurrentSlots: number;
  windowMinutes: number;
  admitBatchMax: number;
  waitingMessage: string | null;
}

export interface EventSummaryDto {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: EventCategory;
  description: string | null;
  imageUrl: string | null;
  status: EventStatus;
  featured: boolean;
  urgencyNote: string | null;
  ageRestriction: string | null;
  /** Próxima función (o la primera, si todas pasaron). */
  nextDate: string | null;
  city: string | null;
  venueName: string | null;
  minPrice: string | null;
  capacity: number;
  datesCount: number;
}

export type PublicEventDto = EventSummaryDto & { queue: QueueSettingsDto; dates: EventDateDto[] };

export interface SeatMapDto {
  date: {
    id: string;
    startsAt: string;
    doorsAt: string | null;
    onSale: boolean;
    event: { id: string; slug: string; title: string; status: EventStatus };
    venue: { id: string; name: string; city: string; mapWidth: number; mapHeight: number };
  };
  sections: {
    id: string;
    name: string;
    kind: SectionKind;
    capacity: number;
    sortOrder: number;
    shape: { x: number; y: number; w: number; h: number };
  }[];
  ticketTypes: TicketTypeDto[];
  seats: {
    id: string;
    sectionId: string;
    row: string;
    number: number;
    x: number;
    y: number;
    blocked: boolean;
  }[];
}

export interface EventInput {
  title: string;
  artist: string | null;
  category: EventCategory;
  description: string | null;
  imageId: string | null;
  status: EventStatus;
  featured: boolean;
  urgencyNote: string | null;
  ageRestriction: string | null;
}

export interface TicketTypeInput {
  sectionId: string;
  name: string;
  price: CLP;
  fee: CLP;
  capacity: number;
}

export interface EventDateInput {
  venueId: string;
  startsAt: Date;
  doorsAt: Date | null;
  onSale: boolean;
  ticketTypes: TicketTypeInput[];
}

export interface ListEventsQuery {
  category?: EventCategory | undefined;
  city?: string | undefined;
  q?: string | undefined;
  sort?: "date" | "popular" | "price" | undefined;
  featured?: boolean | undefined;
}

export interface EventService {
  listPublic(query: ListEventsQuery): Promise<{ events: EventSummaryDto[]; cities: string[] }>;
  getPublic(slug: string): Promise<PublicEventDto>;
  /** Para otros servicios (inventory, queue): mismo contenido público, por id. */
  getPublicById(id: string): Promise<PublicEventDto>;
  seatMap(dateId: string): Promise<SeatMapDto>;
  listForAdmin(actor: Actor): Promise<EventDto[]>;
  getForAdmin(actor: Actor, id: string): Promise<EventDto>;
  create(actor: Actor, input: EventInput, correlationId?: string): Promise<EventDto>;
  update(actor: Actor, id: string, input: EventInput, correlationId?: string): Promise<EventDto>;
  remove(actor: Actor, id: string, correlationId?: string): Promise<void>;
  updateQueue(
    actor: Actor,
    id: string,
    input: QueueSettingsInput,
    correlationId?: string,
  ): Promise<EventDto>;
  createDate(
    actor: Actor,
    eventId: string,
    input: EventDateInput,
    correlationId?: string,
  ): Promise<EventDto>;
  updateDate(
    actor: Actor,
    dateId: string,
    input: EventDateInput,
    correlationId?: string,
  ): Promise<EventDto>;
  removeDate(actor: Actor, dateId: string, correlationId?: string): Promise<EventDto>;
}

const SERVICE_SOURCE = "catalog";

interface EventRow {
  id: string;
  slug: string;
  title: string;
  artist: string | null;
  category: EventCategory;
  description: string | null;
  image_id: string | null;
  status: EventStatus;
  featured: boolean;
  urgency_note: string | null;
  age_restriction: string | null;
  owner_id: string | null;
  queue_enabled: boolean;
  queue_opens_at: Date | null;
  queue_concurrent_slots: number;
  queue_window_minutes: number;
  queue_admit_batch_max: number;
  queue_waiting_message: string | null;
  dates: {
    id: string;
    starts_at: string;
    doors_at: string | null;
    on_sale: boolean;
    venue: { id: string; name: string; city: string };
    ticket_types: {
      id: string;
      name: string;
      price: string;
      service_fee: string;
      capacity: number;
      section_id: string;
      section_kind: SectionKind;
      sort_order: number;
    }[];
  }[];
}

/** Evento con fechas, recinto y tipos de entrada en una sola consulta. */
const EVENT_SQL = `
  select e.id, e.slug, e.title, e.artist, e.category, e.description, e.image_id, e.status,
         e.featured, e.urgency_note, e.age_restriction, e.owner_id, e.queue_enabled,
         e.queue_opens_at, e.queue_concurrent_slots, e.queue_window_minutes,
         e.queue_admit_batch_max, e.queue_waiting_message,
         coalesce((
           select json_agg(json_build_object(
             'id', d.id, 'starts_at', d.starts_at, 'doors_at', d.doors_at, 'on_sale', d.on_sale,
             'venue', json_build_object('id', v.id, 'name', v.name, 'city', v.city),
             'ticket_types', coalesce((
               select json_agg(json_build_object(
                 'id', t.id, 'name', t.name, 'price', t.price::text,
                 'service_fee', t.service_fee::text, 'capacity', t.capacity,
                 'section_id', t.section_id, 'section_kind', s.kind, 'sort_order', s.sort_order
               ) order by s.sort_order, s.name)
               from ticket_types t join venue_sections s on s.id = t.section_id
               where t.event_date_id = d.id
             ), '[]')
           ) order by d.starts_at)
           from event_dates d join venues v on v.id = d.venue_id
           where d.event_id = e.id
         ), '[]') as dates
  from events e`;

function toTicketTypeDto(row: EventRow["dates"][number]["ticket_types"][number]): TicketTypeDto {
  return {
    id: row.id,
    name: row.name,
    price: money(row.price),
    fee: money(row.service_fee),
    capacity: row.capacity,
    sectionId: row.section_id,
    sectionKind: row.section_kind,
    sortOrder: row.sort_order,
  };
}

export function eventDtoFromRow(row: EventRow, media: Pick<MediaService, "url">): EventDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    artist: row.artist,
    category: row.category,
    description: row.description,
    imageId: row.image_id,
    imageUrl: row.image_id ? media.url(row.image_id) : null,
    status: row.status,
    featured: row.featured,
    urgencyNote: row.urgency_note,
    ageRestriction: row.age_restriction,
    ownerId: row.owner_id,
    queue: {
      enabled: row.queue_enabled,
      opensAt: row.queue_opens_at ? row.queue_opens_at.toISOString() : null,
      concurrentSlots: row.queue_concurrent_slots,
      windowMinutes: row.queue_window_minutes,
      admitBatchMax: row.queue_admit_batch_max,
      waitingMessage: row.queue_waiting_message,
    },
    dates: row.dates.map((date) => ({
      id: date.id,
      startsAt: toIso(date.starts_at)!,
      doorsAt: toIso(date.doors_at),
      onSale: date.on_sale,
      venue: date.venue,
      ticketTypes: date.ticket_types.map(toTicketTypeDto),
    })),
  };
}

/** Resumen público (tarjetas y listados). */
export function summarize(event: EventDto, now = Date.now()): EventSummaryDto {
  const upcoming = event.dates.filter((date) => Date.parse(date.startsAt) >= now);
  const reference = upcoming[0] ?? event.dates[0];
  const prices = event.dates.flatMap((date) => date.ticketTypes.map((type) => BigInt(type.price)));
  const minPrice = prices.length > 0 ? prices.reduce((a, b) => (b < a ? b : a)) : null;
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    artist: event.artist,
    category: event.category,
    description: event.description,
    imageUrl: event.imageUrl,
    status: event.status,
    featured: event.featured,
    urgencyNote: event.urgencyNote,
    ageRestriction: event.ageRestriction,
    nextDate: reference?.startsAt ?? null,
    city: reference?.venue.city ?? null,
    venueName: reference?.venue.name ?? null,
    minPrice: minPrice === null ? null : minPrice.toString(),
    capacity: event.dates.reduce(
      (total, date) => total + date.ticketTypes.reduce((sum, type) => sum + type.capacity, 0),
      0,
    ),
    datesCount: upcoming.length,
  };
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function filterAndSort(
  events: EventSummaryDto[],
  query: ListEventsQuery,
): EventSummaryDto[] {
  let result = events;
  if (query.category) result = result.filter((event) => event.category === query.category);
  if (query.city) result = result.filter((event) => event.city === query.city);
  if (query.featured !== undefined) {
    result = result.filter((event) => event.featured === query.featured);
  }
  if (query.q) {
    const q = normalize(query.q);
    result = result.filter((event) =>
      [event.title, event.artist ?? "", event.venueName ?? ""].some((field) =>
        normalize(field).includes(q),
      ),
    );
  }
  const byDate = (a: EventSummaryDto, b: EventSummaryDto) =>
    (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999");
  const sort = query.sort ?? "date";
  return [...result].sort((a, b) => {
    if (sort === "price") {
      const pa = a.minPrice === null ? Number.POSITIVE_INFINITY : Number(a.minPrice);
      const pb = b.minPrice === null ? Number.POSITIVE_INFINITY : Number(b.minPrice);
      return pa - pb || byDate(a, b);
    }
    // "Populares": destacados primero. La demanda real (vendidos) es de inventory (Fase 4).
    if (sort === "popular") return Number(b.featured) - Number(a.featured) || byDate(a, b);
    return byDate(a, b);
  });
}

function toPublic(event: EventDto): PublicEventDto {
  return { ...summarize(event), queue: event.queue, dates: event.dates };
}

export function createEventService(options: {
  pool: Pool;
  cache: ReadCache;
  media: Pick<MediaService, "url">;
}): EventService {
  const { pool, cache, media } = options;

  async function loadEvent(
    db: Queryable,
    where: string,
    value: string,
  ): Promise<EventDto | undefined> {
    const result = await db.query<EventRow>(`${EVENT_SQL} where ${where}`, [value]);
    const row = result.rows[0];
    return row ? eventDtoFromRow(row, media) : undefined;
  }

  async function requireEvent(db: Queryable, id: string): Promise<EventDto> {
    const event = await loadEvent(db, "e.id = $1", id);
    if (!event) throw AppError.notFound("El evento no existe");
    return event;
  }

  /** Bloquea el evento (serializa los cambios y el orden de sus eventos de dominio). */
  async function lockEvent(
    db: Queryable,
    actor: Actor,
    id: string,
  ): Promise<{ owner_id: string | null }> {
    const result = await db.query<{ owner_id: string | null }>(
      "select owner_id from events where id = $1 for update",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw AppError.notFound("El evento no existe");
    assertCanManage(actor, row.owner_id);
    return row;
  }

  /** Estado completo del evento para los consumidores (event-carried state transfer). */
  async function publishUpdated(db: Queryable, eventId: string, correlationId?: string) {
    const event = await requireEvent(db, eventId);
    await enqueueOutbox(
      db,
      createEvent({
        type: "EventoActualizado",
        source: SERVICE_SOURCE,
        aggregateId: event.id,
        correlationId,
        data: {
          eventId: event.id,
          slug: event.slug,
          title: event.title,
          status: event.status,
          ownerId: event.ownerId,
          queue: event.queue,
          dates: event.dates.map((date) => ({
            dateId: date.id,
            venueId: date.venue.id,
            startsAt: date.startsAt,
            onSale: date.onSale,
            ticketTypes: date.ticketTypes.map((type) => ({
              ticketTypeId: type.id,
              sectionId: type.sectionId,
              seated: type.sectionKind === "seated",
              capacity: type.capacity,
              price: type.price,
              fee: type.fee,
            })),
          })),
        },
      }),
    );
    return event;
  }

  async function assertImage(db: Queryable, imageId: string | null) {
    if (imageId === null) return;
    const result = await db.query("select 1 from media where id = $1", [imageId]);
    if ((result.rowCount ?? 0) === 0) {
      throw AppError.validation([{ path: "imageId", message: "La imagen no existe" }]);
    }
  }

  /** Valida recinto, sectores y capacidades; crea o actualiza los tipos de entrada. */
  async function saveTicketTypes(db: Queryable, dateId: string, input: EventDateInput) {
    const sections = await db.query<{ id: string; capacity: number }>(
      "select id, capacity from venue_sections where venue_id = $1",
      [input.venueId],
    );
    const byId = new Map(sections.rows.map((section) => [section.id, section]));
    const seen = new Set<string>();
    input.ticketTypes.forEach((type, index) => {
      const section = byId.get(type.sectionId);
      if (!section) {
        throw AppError.validation([
          { path: `ticketTypes.${index}.sectionId`, message: "El sector no pertenece al recinto" },
        ]);
      }
      if (seen.has(type.sectionId)) {
        throw AppError.validation([
          { path: `ticketTypes.${index}.sectionId`, message: "Sector repetido" },
        ]);
      }
      seen.add(type.sectionId);
      if (type.capacity > section.capacity) {
        throw AppError.validation([
          {
            path: `ticketTypes.${index}.capacity`,
            message: `Supera la capacidad del sector (${section.capacity})`,
          },
        ]);
      }
    });
    for (const type of input.ticketTypes) {
      await db.query(
        `insert into ticket_types (id, event_date_id, section_id, name, price, service_fee, capacity)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (event_date_id, section_id) do update set
           name = excluded.name, price = excluded.price, service_fee = excluded.service_fee,
           capacity = excluded.capacity, updated_at = now()`,
        [newId(), dateId, type.sectionId, type.name, type.price, type.fee, type.capacity],
      );
    }
  }

  async function assertVenue(db: Queryable, venueId: string) {
    const result = await db.query("select 1 from venues where id = $1", [venueId]);
    if ((result.rowCount ?? 0) === 0) {
      throw AppError.validation([{ path: "venueId", message: "El recinto no existe" }]);
    }
  }

  async function allPublic(): Promise<EventSummaryDto[]> {
    return cache.get("events:public", async () => {
      const result = await pool.query<EventRow>(
        `${EVENT_SQL} where e.status = any($1::text[]) order by e.created_at`,
        [PUBLIC_STATUSES],
      );
      return result.rows.map((row) => summarize(eventDtoFromRow(row, media)));
    });
  }

  return {
    async listPublic(query) {
      const events = await allPublic();
      const cities = [...new Set(events.map((event) => event.city).filter((c) => c !== null))];
      return { events: filterAndSort(events, query), cities: cities.sort() };
    },

    async getPublic(slug) {
      const event = await cache.get(`event:${slug}`, async () => {
        const found = await loadEvent(pool, "e.slug = $1", slug);
        if (!found || !PUBLIC_STATUSES.includes(found.status)) return null;
        return toPublic(found);
      });
      if (!event) throw AppError.notFound("El evento no existe");
      return event;
    },

    async getPublicById(id) {
      const event = await cache.get(`event-id:${id}`, async () => {
        const found = await loadEvent(pool, "e.id = $1", id);
        if (!found || !PUBLIC_STATUSES.includes(found.status)) return null;
        return toPublic(found);
      });
      if (!event) throw AppError.notFound("El evento no existe");
      return event;
    },

    async updateQueue(actor, id, input, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        await lockEvent(client, actor, id);
        await client.query(
          `update events set queue_enabled = $2, queue_opens_at = $3, queue_concurrent_slots = $4,
             queue_window_minutes = $5, queue_admit_batch_max = $6, queue_waiting_message = $7,
             updated_at = now()
           where id = $1`,
          [
            id,
            input.enabled,
            input.opensAt,
            input.concurrentSlots,
            input.windowMinutes,
            input.admitBatchMax,
            input.waitingMessage,
          ],
        );
        return publishUpdated(client, id, correlationId);
      });
      await cache.invalidate();
      return event;
    },

    async seatMap(dateId) {
      const map = await cache.get(`seat-map:${dateId}`, async () => {
        const dateResult = await pool.query<{
          id: string;
          starts_at: Date;
          doors_at: Date | null;
          on_sale: boolean;
          event_id: string;
          slug: string;
          title: string;
          status: EventStatus;
          venue_id: string;
          venue_name: string;
          city: string;
          map_width: number;
          map_height: number;
        }>(
          `select d.id, d.starts_at, d.doors_at, d.on_sale, e.id as event_id, e.slug, e.title,
                  e.status, v.id as venue_id, v.name as venue_name, v.city, v.map_width, v.map_height
           from event_dates d
           join events e on e.id = d.event_id
           join venues v on v.id = d.venue_id
           where d.id = $1 and e.status = any($2::text[])`,
          [dateId, PUBLIC_STATUSES],
        );
        const date = dateResult.rows[0];
        if (!date) return null;
        const [sections, types, seats] = await Promise.all([
          pool.query<{
            id: string;
            name: string;
            kind: SectionKind;
            capacity: number;
            sort_order: number;
            shape_x: number;
            shape_y: number;
            shape_w: number;
            shape_h: number;
          }>("select * from venue_sections where venue_id = $1 order by sort_order, name", [
            date.venue_id,
          ]),
          pool.query<EventRow["dates"][number]["ticket_types"][number]>(
            `select t.id, t.name, t.price::text as price, t.service_fee::text as service_fee,
                    t.capacity, t.section_id, s.kind as section_kind, s.sort_order
             from ticket_types t join venue_sections s on s.id = t.section_id
             where t.event_date_id = $1 order by s.sort_order, s.name`,
            [dateId],
          ),
          pool.query<{
            id: string;
            section_id: string;
            row_label: string;
            seat_number: number;
            x: string;
            y: string;
            blocked: boolean;
          }>(
            `select st.id, st.section_id, st.row_label, st.seat_number, st.x, st.y, st.blocked
             from venue_seats st join venue_sections s on s.id = st.section_id
             where s.venue_id = $1 order by st.section_id, st.row_label, st.seat_number`,
            [date.venue_id],
          ),
        ]);
        return {
          date: {
            id: date.id,
            startsAt: date.starts_at.toISOString(),
            doorsAt: date.doors_at ? date.doors_at.toISOString() : null,
            onSale: date.on_sale,
            event: { id: date.event_id, slug: date.slug, title: date.title, status: date.status },
            venue: {
              id: date.venue_id,
              name: date.venue_name,
              city: date.city,
              mapWidth: date.map_width,
              mapHeight: date.map_height,
            },
          },
          sections: sections.rows.map((section) => ({
            id: section.id,
            name: section.name,
            kind: section.kind,
            capacity: section.capacity,
            sortOrder: section.sort_order,
            shape: {
              x: section.shape_x,
              y: section.shape_y,
              w: section.shape_w,
              h: section.shape_h,
            },
          })),
          ticketTypes: types.rows.map(toTicketTypeDto),
          seats: seats.rows.map((seat) => ({
            id: seat.id,
            sectionId: seat.section_id,
            row: seat.row_label,
            number: seat.seat_number,
            x: Number(seat.x),
            y: Number(seat.y),
            blocked: seat.blocked,
          })),
        } satisfies SeatMapDto;
      });
      if (!map) throw AppError.notFound("La fecha no existe");
      return map;
    },

    async listForAdmin(actor) {
      const result = isAdmin(actor)
        ? await pool.query<EventRow>(`${EVENT_SQL} order by e.created_at desc`)
        : await pool.query<EventRow>(
            `${EVENT_SQL} where e.owner_id = $1 order by e.created_at desc`,
            [actor.id],
          );
      return result.rows.map((row) => eventDtoFromRow(row, media));
    },

    async getForAdmin(actor, id) {
      const event = await requireEvent(pool, id);
      assertCanManage(actor, event.ownerId);
      return event;
    },

    async create(actor, input, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        await assertImage(client, input.imageId);
        const id = newId();
        // Un organizador es dueño de lo que crea; lo que crea un admin es de la plataforma.
        const ownerId = isAdmin(actor) ? null : actor.id;
        for (let attempt = 0; ; attempt += 1) {
          try {
            await client.query("savepoint slug");
            await client.query(
              `insert into events (id, slug, title, artist, category, description, image_id, status,
                 featured, urgency_note, age_restriction, owner_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                id,
                uniqueSlug(input.title),
                input.title,
                input.artist,
                input.category,
                input.description,
                input.imageId,
                input.status,
                input.featured,
                input.urgencyNote,
                input.ageRestriction,
                ownerId,
              ],
            );
            break;
          } catch (error) {
            await client.query("rollback to savepoint slug");
            if (!isUniqueViolation(error) || attempt >= 2) throw error;
          }
        }
        return publishUpdated(client, id, correlationId);
      });
      await cache.invalidate();
      return event;
    },

    async update(actor, id, input, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        await lockEvent(client, actor, id);
        await assertImage(client, input.imageId);
        await client.query(
          `update events set title = $2, artist = $3, category = $4, description = $5,
             image_id = $6, status = $7, featured = $8, urgency_note = $9, age_restriction = $10,
             updated_at = now()
           where id = $1`,
          [
            id,
            input.title,
            input.artist,
            input.category,
            input.description,
            input.imageId,
            input.status,
            input.featured,
            input.urgencyNote,
            input.ageRestriction,
          ],
        );
        return publishUpdated(client, id, correlationId);
      });
      await cache.invalidate();
      return event;
    },

    async remove(actor, id, correlationId) {
      await withTransaction(pool, async (client) => {
        await lockEvent(client, actor, id);
        await client.query("delete from events where id = $1", [id]);
        await enqueueOutbox(
          client,
          createEvent({
            type: "EventoEliminado",
            source: SERVICE_SOURCE,
            aggregateId: id,
            correlationId,
            data: { eventId: id },
          }),
        );
      });
      await cache.invalidate();
    },

    async createDate(actor, eventId, input, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        await lockEvent(client, actor, eventId);
        await assertVenue(client, input.venueId);
        const dateId = newId();
        await client.query(
          `insert into event_dates (id, event_id, venue_id, starts_at, doors_at, on_sale)
           values ($1, $2, $3, $4, $5, $6)`,
          [dateId, eventId, input.venueId, input.startsAt, input.doorsAt, input.onSale],
        );
        await saveTicketTypes(client, dateId, input);
        return publishUpdated(client, eventId, correlationId);
      });
      await cache.invalidate();
      return event;
    },

    async updateDate(actor, dateId, input, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        const current = await client.query<{ event_id: string; venue_id: string }>(
          "select event_id, venue_id from event_dates where id = $1",
          [dateId],
        );
        const row = current.rows[0];
        if (!row) throw AppError.notFound("La fecha no existe");
        await lockEvent(client, actor, row.event_id);
        if (row.venue_id !== input.venueId) {
          await assertVenue(client, input.venueId);
          const types = await client.query("select 1 from ticket_types where event_date_id = $1", [
            dateId,
          ]);
          if ((types.rowCount ?? 0) > 0) {
            throw AppError.conflict(
              "DATE_HAS_TICKET_TYPES",
              "No se puede cambiar el recinto de una fecha con entradas publicadas",
            );
          }
        }
        await client.query(
          `update event_dates set venue_id = $2, starts_at = $3, doors_at = $4, on_sale = $5
           where id = $1`,
          [dateId, input.venueId, input.startsAt, input.doorsAt, input.onSale],
        );
        await saveTicketTypes(client, dateId, input);
        return publishUpdated(client, row.event_id, correlationId);
      });
      await cache.invalidate();
      return event;
    },

    async removeDate(actor, dateId, correlationId) {
      const event = await withTransaction(pool, async (client) => {
        const current = await client.query<{ event_id: string }>(
          "select event_id from event_dates where id = $1",
          [dateId],
        );
        const row = current.rows[0];
        if (!row) throw AppError.notFound("La fecha no existe");
        await lockEvent(client, actor, row.event_id);
        await client.query("delete from event_dates where id = $1", [dateId]);
        return publishUpdated(client, row.event_id, correlationId);
      });
      await cache.invalidate();
      return event;
    },
  };
}
