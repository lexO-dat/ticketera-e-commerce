import {
  AppError,
  DEFAULT_RESERVATION_TTL_SECONDS,
  ErrorCode,
  type Logger,
  createEvent,
  newId,
} from "@shared/commons";
import { type Admission, admissionJtiKey, admissionRequired } from "@shared/commons/auth";
import { type Pool, type Queryable, enqueueOutbox, withTransaction } from "@shared/commons/db";
import type { Redis } from "@shared/commons/redis";
import type { CatalogClient } from "./catalog-client.js";
import { ensureEvent } from "./projection.js";

/** Máximo de entradas reservadas a la vez por usuario y fecha (como el prototipo). */
export const MAX_TICKETS_PER_USER_AND_DATE = 8;

export interface ReservationDto {
  id: string;
  status: "ACTIVE" | "SOLD" | "RELEASED" | "EXPIRED";
  eventId: string;
  eventDateId: string;
  ticketTypeId: string;
  quantity: number;
  seatIds: string[];
  expiresAt: string;
}

export interface ReserveInput {
  ticketTypeId: string;
  /** Sectores generales. */
  quantity?: number | undefined;
  /** Sectores numerados: la cantidad es el número de butacas. */
  seatIds?: string[] | undefined;
}

export interface TicketAvailability {
  ticketTypeId: string;
  eventDateId: string;
  capacity: number;
  sold: number;
  reserved: number;
  available: number;
  onSale: boolean;
}

const SOURCE = "inventory";

function conflict(reason: string, detail: string, extra?: string[]): AppError {
  return new AppError(ErrorCode.CONFLICT, undefined, {
    reason,
    detail,
    ...(extra ? { issues: extra.map((id) => ({ path: "seatIds", message: id })) } : {}),
  });
}

interface InventoryRow {
  ticket_type_id: string;
  event_id: string;
  event_date_id: string;
  section_id: string;
  seated: boolean;
  capacity: number;
  on_sale: boolean;
  starts_at: Date;
  active: boolean;
  reserved: number;
  sold: number;
  status: string;
  queue_enabled: boolean;
}

/**
 * Vence (perezosamente, ADR-03) las reservas activas ya expiradas de un tipo de entrada.
 * Debe llamarse con la fila de `ticket_inventory` bloqueada (FOR UPDATE).
 */
export async function expireDue(db: Queryable, ticketTypeId: string, correlationId?: string) {
  const expired = await db.query<{ id: string; quantity: number }>(
    `update reservations set status = 'EXPIRED', release_reason = 'EXPIRED', finished_at = now()
     where ticket_type_id = $1 and status = 'ACTIVE' and expires_at <= now()
     returning id, quantity`,
    [ticketTypeId],
  );
  if (expired.rows.length === 0) return 0;
  const ids = expired.rows.map((row) => row.id);
  const total = expired.rows.reduce((sum, row) => sum + row.quantity, 0);
  await db.query(
    "update reservation_seats set holding = false where reservation_id = any($1::uuid[])",
    [ids],
  );
  await db.query(
    "update ticket_inventory set reserved = reserved - $2, updated_at = now() where ticket_type_id = $1",
    [ticketTypeId, total],
  );
  for (const id of ids) {
    await enqueueOutbox(
      db,
      createEvent({
        type: "ReservaLiberada",
        source: SOURCE,
        aggregateId: id,
        correlationId,
        data: { reservationId: id, reason: "EXPIRED" },
      }),
    );
  }
  return ids.length;
}

export function createReservationService(options: {
  pool: Pool;
  redis: Redis;
  catalog: CatalogClient;
  logger: Logger;
  ttlSeconds?: number;
}) {
  const { pool, redis, catalog, logger } = options;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;

  async function loadDto(db: Queryable, id: string): Promise<ReservationDto | undefined> {
    const result = await db.query<{
      id: string;
      status: ReservationDto["status"];
      event_id: string;
      event_date_id: string;
      ticket_type_id: string;
      quantity: number;
      expires_at: Date;
      seat_ids: string[];
      user_id: string;
    }>(
      `select r.*, coalesce(array_agg(s.seat_id) filter (where s.seat_id is not null), '{}') as seat_ids
       from reservations r left join reservation_seats s on s.reservation_id = r.id
       where r.id = $1 group by r.id`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      // Expiración perezosa también en la lectura: vencida deja de contar al consultarla.
      status:
        row.status === "ACTIVE" && row.expires_at.getTime() <= Date.now() ? "EXPIRED" : row.status,
      eventId: row.event_id,
      eventDateId: row.event_date_id,
      ticketTypeId: row.ticket_type_id,
      quantity: row.quantity,
      seatIds: row.seat_ids,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Fila virtual (ADR-06): token válido, del mismo usuario y evento, y jti aún vigente. */
  async function assertAdmission(
    userId: string,
    eventId: string,
    admission: Admission | undefined,
  ) {
    if (!admission) throw admissionRequired();
    if (admission.userId !== userId || admission.eventId !== eventId) {
      throw admissionRequired("El turno de la fila no corresponde a esta compra");
    }
    let holder: string | null;
    try {
      holder = await redis.get(admissionJtiKey(eventId, admission.jti));
    } catch {
      // Sin poder verificar el turno no se reserva (antes indisponible que sobreventa).
      throw AppError.unavailable("No se pudo verificar tu turno; intenta en un momento", 5);
    }
    if (holder !== userId) throw admissionRequired("Tu turno de compra terminó; vuelve a la fila");
  }

  async function lockInventory(
    db: Queryable,
    ticketTypeId: string,
  ): Promise<InventoryRow | undefined> {
    const result = await db.query<InventoryRow>(
      `select t.*, e.status, e.queue_enabled
       from ticket_inventory t join event_projection e on e.event_id = t.event_id
       where t.ticket_type_id = $1
       for update of t`,
      [ticketTypeId],
    );
    return result.rows[0];
  }

  return {
    get: (id: string) => loadDto(pool, id),

    async ownerOf(id: string): Promise<string | undefined> {
      const result = await pool.query<{ user_id: string }>(
        "select user_id from reservations where id = $1",
        [id],
      );
      return result.rows[0]?.user_id;
    },

    async reserve(
      userId: string,
      input: ReserveInput,
      admission: Admission | undefined,
      correlationId?: string,
    ): Promise<ReservationDto> {
      // Completa la proyección si el tipo de entrada aún no se conoce (antes de abrir la transacción).
      const known = await pool.query("select 1 from ticket_inventory where ticket_type_id = $1", [
        input.ticketTypeId,
      ]);
      if ((known.rowCount ?? 0) === 0) {
        const eventId = await catalog.eventIdForTicketType(input.ticketTypeId);
        if (!eventId || !(await ensureEvent(pool, catalog, eventId))) {
          throw AppError.notFound("El tipo de entrada no existe");
        }
      }

      const peek = await pool.query<{
        event_id: string;
        queue_enabled: boolean;
        seated: boolean;
        event_date_id: string;
        section_id: string;
      }>(
        `select t.event_id, t.seated, t.event_date_id, t.section_id, e.queue_enabled
         from ticket_inventory t join event_projection e on e.event_id = t.event_id
         where t.ticket_type_id = $1`,
        [input.ticketTypeId],
      );
      const info = peek.rows[0];
      if (!info) throw AppError.notFound("El tipo de entrada no existe");
      if (info.queue_enabled) await assertAdmission(userId, info.event_id, admission);

      const seatIds = [...new Set(input.seatIds ?? [])];
      if (info.seated) {
        if (seatIds.length === 0) {
          throw AppError.validation([{ path: "seatIds", message: "Elige tus butacas" }]);
        }
        // Las butacas deben ser del sector de este tipo de entrada y no estar bloqueadas.
        const seats = await catalog.seats(info.event_date_id);
        const invalid = seatIds.filter((id) => {
          const seat = seats.get(id);
          return !seat || seat.sectionId !== info.section_id || seat.blocked;
        });
        if (invalid.length > 0) {
          throw AppError.validation(
            invalid.map((id) => ({ path: "seatIds", message: `Butaca no disponible: ${id}` })),
          );
        }
      } else if (seatIds.length > 0 || !input.quantity) {
        throw AppError.validation([
          { path: "quantity", message: "Indica la cantidad (sector general)" },
        ]);
      }
      const quantity = info.seated ? seatIds.length : input.quantity!;

      const reservationId = await withTransaction(pool, async (client) => {
        // Bloqueo pesimista (ADR-03): serializa las reservas del tipo de entrada.
        const row = await lockInventory(client, input.ticketTypeId);
        if (!row) throw AppError.notFound("El tipo de entrada no existe");
        if (row.status !== "published") {
          throw conflict(
            row.status === "soldout" ? "SOLD_OUT" : "NOT_ON_SALE",
            "El evento no está a la venta",
          );
        }
        if (!row.active || !row.on_sale)
          throw conflict("NOT_ON_SALE", "Estas entradas no están a la venta");
        if (row.starts_at.getTime() <= Date.now())
          throw conflict("NOT_ON_SALE", "La función ya comenzó");

        await expireDue(client, row.ticket_type_id, correlationId);

        // Serializa las reservas de un mismo usuario y fecha (el límite cruza tipos de entrada).
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          `${userId}:${row.event_date_id}`,
        ]);
        const held = await client.query<{ total: string }>(
          `select coalesce(sum(quantity), 0) as total from reservations
           where user_id = $1 and event_date_id = $2 and status = 'ACTIVE' and expires_at > now()`,
          [userId, row.event_date_id],
        );
        if (Number(held.rows[0]!.total) + quantity > MAX_TICKETS_PER_USER_AND_DATE) {
          throw conflict(
            "LIMIT_PER_USER",
            `Máximo ${MAX_TICKETS_PER_USER_AND_DATE} entradas por función`,
          );
        }

        // Contador con condición en la misma sentencia: nunca supera la capacidad.
        const counted = await client.query(
          `update ticket_inventory set reserved = reserved + $2, updated_at = now()
           where ticket_type_id = $1 and sold + reserved + $2 <= capacity`,
          [row.ticket_type_id, quantity],
        );
        if (counted.rowCount === 0) {
          throw conflict("NOT_ENOUGH_AVAILABLE", "No quedan suficientes entradas disponibles");
        }

        const id = newId();
        await client.query(
          `insert into reservations (id, user_id, event_id, event_date_id, ticket_type_id, quantity,
             status, expires_at, admission_jti)
           values ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + make_interval(secs => $7), $8)`,
          [
            id,
            userId,
            row.event_id,
            row.event_date_id,
            row.ticket_type_id,
            quantity,
            ttlSeconds,
            admission?.jti ?? null,
          ],
        );

        if (row.seated) {
          const taken = await client.query<{ seat_id: string }>(
            `select seat_id from reservation_seats
             where event_date_id = $1 and seat_id = any($2::uuid[]) and holding`,
            [row.event_date_id, seatIds],
          );
          if (taken.rows.length > 0) {
            throw conflict(
              "SEAT_TAKEN",
              "Alguien tomó una de tus butacas; elige otra",
              taken.rows.map((seat) => seat.seat_id),
            );
          }
          // El índice único parcial es la última defensa si algo se escapara del bloqueo.
          await client.query(
            `insert into reservation_seats (reservation_id, event_date_id, seat_id, ticket_type_id)
             select $1, $2, unnest($3::uuid[]), $4`,
            [id, row.event_date_id, seatIds, row.ticket_type_id],
          );
        }

        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        await enqueueOutbox(
          client,
          createEvent({
            type: "ReservaCreada",
            source: SOURCE,
            aggregateId: id,
            correlationId,
            data: { reservationId: id, userId, itemId: row.ticket_type_id, quantity, expiresAt },
          }),
        );
        return id;
      });
      logger.debug({ reservationId, quantity }, "reserva creada");
      return (await loadDto(pool, reservationId))!;
    },

    /** Liberación explícita por el dueño: inmediata (ADR-03: < 500 ms). */
    async release(userId: string, reservationId: string, correlationId?: string): Promise<void> {
      const current = await pool.query<{ ticket_type_id: string; user_id: string }>(
        "select ticket_type_id, user_id from reservations where id = $1",
        [reservationId],
      );
      const row = current.rows[0];
      if (!row || row.user_id !== userId) throw AppError.notFound("La reserva no existe");
      await withTransaction(pool, async (client) => {
        // Mismo orden de bloqueo que reserve (inventario → reserva): sin deadlocks.
        await lockInventory(client, row.ticket_type_id);
        const released = await client.query<{ quantity: number }>(
          `update reservations set status = 'RELEASED', release_reason = 'USER', finished_at = now()
           where id = $1 and status = 'ACTIVE' returning quantity`,
          [reservationId],
        );
        const quantity = released.rows[0]?.quantity;
        if (quantity === undefined) return;
        await client.query(
          "update reservation_seats set holding = false where reservation_id = $1",
          [reservationId],
        );
        await client.query(
          "update ticket_inventory set reserved = reserved - $2, updated_at = now() where ticket_type_id = $1",
          [row.ticket_type_id, quantity],
        );
        await enqueueOutbox(
          client,
          createEvent({
            type: "ReservaLiberada",
            source: SOURCE,
            aggregateId: reservationId,
            correlationId,
            data: { reservationId, reason: "USER" },
          }),
        );
      });
    },

    async mine(userId: string, eventDateId?: string): Promise<ReservationDto[]> {
      const result = await pool.query<{ id: string }>(
        `select id from reservations
         where user_id = $1 and status = 'ACTIVE' and expires_at > now()
           and ($2::uuid is null or event_date_id = $2)
         order by created_at`,
        [userId, eventDateId ?? null],
      );
      const items = await Promise.all(result.rows.map((row) => loadDto(pool, row.id)));
      return items.filter((item): item is ReservationDto => item !== undefined);
    },

    /** Disponibilidad por tipo de entrada; las reservas vencidas no cuentan aunque no se hayan barrido. */
    async availability(eventId: string): Promise<TicketAvailability[] | null> {
      if (!(await ensureEvent(pool, catalog, eventId))) return null;
      const result = await pool.query<{
        ticket_type_id: string;
        event_date_id: string;
        capacity: number;
        sold: number;
        reserved: string;
        on_sale: boolean;
        active: boolean;
      }>(
        `select t.ticket_type_id, t.event_date_id, t.capacity, t.sold, t.on_sale, t.active,
                coalesce((select sum(r.quantity) from reservations r
                          where r.ticket_type_id = t.ticket_type_id and r.status = 'ACTIVE'
                            and r.expires_at > now()), 0) as reserved
         from ticket_inventory t where t.event_id = $1 and t.active
         order by t.event_date_id`,
        [eventId],
      );
      return result.rows.map((row) => {
        const reserved = Number(row.reserved);
        return {
          ticketTypeId: row.ticket_type_id,
          eventDateId: row.event_date_id,
          capacity: row.capacity,
          sold: row.sold,
          reserved,
          available: Math.max(0, row.capacity - row.sold - reserved),
          onSale: row.on_sale,
        };
      });
    },

    /** Butacas ocupadas de una fecha (vendidas o con reserva vigente). */
    async takenSeats(eventDateId: string): Promise<string[]> {
      const result = await pool.query<{ seat_id: string }>(
        `select s.seat_id from reservation_seats s join reservations r on r.id = s.reservation_id
         where s.event_date_id = $1 and s.holding
           and (r.status = 'SOLD' or (r.status = 'ACTIVE' and r.expires_at > now()))`,
        [eventDateId],
      );
      return result.rows.map((row) => row.seat_id);
    },

    /**
     * Barrido periódico (una réplica a la vez): vence las reservas expiradas, devuelve el cupo a
     * los contadores y publica `ReservaLiberada`. La expiración perezosa ya las ignora antes.
     */
    async sweep(limitTypes = 100): Promise<number> {
      const due = await pool.query<{ ticket_type_id: string }>(
        `select distinct ticket_type_id from reservations
         where status = 'ACTIVE' and expires_at <= now() limit $1`,
        [limitTypes],
      );
      let expired = 0;
      for (const { ticket_type_id } of due.rows) {
        expired += await withTransaction(pool, async (client) => {
          await lockInventory(client, ticket_type_id);
          return expireDue(client, ticket_type_id);
        });
      }
      return expired;
    },

    /**
     * Auditoría (simulador y operación): por tipo de entrada, ¿hay sobreventa, butacas duplicadas
     * o deriva entre el contador y las reservas reales?
     */
    async audit(eventId: string) {
      const result = await pool.query<{
        ticket_type_id: string;
        capacity: number;
        sold: number;
        reserved_counter: number;
        reserved_actual: string;
        reserved_including_expired: string;
        duplicate_seats: string;
        seats_holding: string;
        seated: boolean;
      }>(
        `select t.ticket_type_id, t.capacity, t.sold, t.reserved as reserved_counter, t.seated,
           coalesce((select sum(quantity) from reservations r where r.ticket_type_id = t.ticket_type_id
                     and r.status = 'ACTIVE' and r.expires_at > now()), 0) as reserved_actual,
           coalesce((select sum(quantity) from reservations r where r.ticket_type_id = t.ticket_type_id
                     and r.status = 'ACTIVE'), 0) as reserved_including_expired,
           (select count(*) from (select seat_id from reservation_seats s
              where s.ticket_type_id = t.ticket_type_id and s.holding
              group by s.event_date_id, s.seat_id having count(*) > 1) d) as duplicate_seats,
           (select count(*) from reservation_seats s
              where s.ticket_type_id = t.ticket_type_id and s.holding) as seats_holding
         from ticket_inventory t where t.event_id = $1`,
        [eventId],
      );
      const ticketTypes = result.rows.map((row) => {
        const reservedActual = Number(row.reserved_actual);
        const withExpired = Number(row.reserved_including_expired);
        return {
          ticketTypeId: row.ticket_type_id,
          capacity: row.capacity,
          sold: row.sold,
          reserved: reservedActual,
          oversold: row.sold + reservedActual > row.capacity,
          duplicateSeats: Number(row.duplicate_seats),
          counterDrift: row.reserved_counter - withExpired,
          seatDrift: row.seated ? Number(row.seats_holding) - withExpired - row.sold : 0,
        };
      });
      return {
        eventId,
        ok: ticketTypes.every(
          (type) =>
            !type.oversold &&
            type.duplicateSeats === 0 &&
            type.counterDrift === 0 &&
            type.seatDrift === 0,
        ),
        ticketTypes,
      };
    },
  };
}

export type ReservationService = ReturnType<typeof createReservationService>;
