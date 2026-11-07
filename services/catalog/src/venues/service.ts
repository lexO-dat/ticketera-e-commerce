import { AppError, newId } from "@shared/commons";
import { type Pool, type Queryable, withTransaction } from "@shared/commons/db";
import type { ReadCache } from "../cache.js";
import { isForeignKeyViolation } from "../shared.js";

export type SectionKind = "seated" | "general";

export interface SectionDto {
  id: string;
  venueId: string;
  name: string;
  kind: SectionKind;
  capacity: number;
  sortOrder: number;
  shape: { x: number; y: number; w: number; h: number };
}

export interface VenueDto {
  id: string;
  name: string;
  city: string;
  address: string | null;
  capacity: number;
  map: { width: number; height: number };
  sections: SectionDto[];
}

export interface SeatDto {
  id: string;
  sectionId: string;
  row: string;
  number: number;
  x: number;
  y: number;
  blocked: boolean;
}

export interface VenueInput {
  name: string;
  city: string;
  address: string | null;
  capacity: number;
  mapWidth?: number | undefined;
  mapHeight?: number | undefined;
}

export interface SectionInput {
  venueId: string;
  name: string;
  kind: SectionKind;
  capacity: number;
  sortOrder: number;
  shape: { x: number; y: number; w: number; h: number };
  /** Si viene (> 0) en un sector numerado, se regenera la grilla de butacas. */
  seatGrid?: { rows: number; perRow: number } | undefined;
}

export interface VenueService {
  list(): Promise<VenueDto[]>;
  get(id: string): Promise<VenueDto>;
  create(input: VenueInput): Promise<VenueDto>;
  update(id: string, input: VenueInput): Promise<VenueDto>;
  remove(id: string): Promise<void>;
  createSection(input: SectionInput): Promise<SectionDto>;
  updateSection(id: string, input: Omit<SectionInput, "venueId">): Promise<SectionDto>;
  removeSection(id: string): Promise<void>;
  seats(sectionId: string): Promise<SeatDto[]>;
  setSeatBlocked(seatId: string, blocked: boolean): Promise<void>;
}

interface SectionRow {
  id: string;
  venue_id: string;
  name: string;
  kind: SectionKind;
  capacity: number;
  sort_order: number;
  shape_x: number;
  shape_y: number;
  shape_w: number;
  shape_h: number;
}

export function toSectionDto(row: SectionRow): SectionDto {
  return {
    id: row.id,
    venueId: row.venue_id,
    name: row.name,
    kind: row.kind,
    capacity: row.capacity,
    sortOrder: row.sort_order,
    shape: { x: row.shape_x, y: row.shape_y, w: row.shape_w, h: row.shape_h },
  };
}

const VENUES_SQL = `
  select v.id, v.name, v.city, v.address, v.capacity, v.map_width, v.map_height,
         coalesce(json_agg(s order by s.sort_order, s.name) filter (where s.id is not null), '[]') as sections
  from venues v
  left join venue_sections s on s.venue_id = v.id`;

interface VenueRow {
  id: string;
  name: string;
  city: string;
  address: string | null;
  capacity: number;
  map_width: number;
  map_height: number;
  sections: SectionRow[];
}

function toVenueDto(row: VenueRow): VenueDto {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    address: row.address,
    capacity: row.capacity,
    map: { width: row.map_width, height: row.map_height },
    sections: row.sections.map(toSectionDto),
  };
}

/**
 * Grilla de butacas dentro del rectángulo del sector (misma geometría que el editor del
 * prototipo). Filas A–Z, luego A1, B1…
 */
export function seatGrid(options: {
  rows: number;
  perRow: number;
  x: number;
  y: number;
  w: number;
  h: number;
}): { row: string; number: number; x: number; y: number }[] {
  const seats: { row: string; number: number; x: number; y: number }[] = [];
  const stepX = options.perRow > 1 ? options.w / (options.perRow - 1) : 0;
  const stepY = options.rows > 1 ? options.h / (options.rows - 1) : 0;
  for (let r = 0; r < options.rows; r += 1) {
    const label = String.fromCharCode(65 + (r % 26)) + (r >= 26 ? String(Math.floor(r / 26)) : "");
    for (let c = 0; c < options.perRow; c += 1) {
      seats.push({
        row: label,
        number: c + 1,
        x: Math.round(options.x + (options.perRow > 1 ? c * stepX : options.w / 2)),
        y: Math.round(options.y + (options.rows > 1 ? r * stepY : options.h / 2)),
      });
    }
  }
  return seats;
}

const SEAT_PADDING = 12;

export function createVenueService(options: { pool: Pool; cache: ReadCache }): VenueService {
  const { pool, cache } = options;

  async function findVenue(db: Queryable, id: string): Promise<VenueDto> {
    const result = await db.query<VenueRow>(`${VENUES_SQL} where v.id = $1 group by v.id`, [id]);
    const row = result.rows[0];
    if (!row) throw AppError.notFound("El recinto no existe");
    return toVenueDto(row);
  }

  async function findSection(db: Queryable, id: string, lock = false): Promise<SectionRow> {
    const result = await db.query<SectionRow>(
      `select * from venue_sections where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw AppError.notFound("El sector no existe");
    return row;
  }

  /** En un sector numerado la capacidad es siempre su número de butacas (no la del cliente). */
  async function syncSeatedCapacity(db: Queryable, row: SectionRow): Promise<SectionRow> {
    if (row.kind !== "seated") return row;
    const result = await db.query<SectionRow>(
      `update venue_sections
       set capacity = (select count(*) from venue_seats where section_id = $1)
       where id = $1 returning *`,
      [row.id],
    );
    return result.rows[0]!;
  }

  /** Regenera la grilla de butacas; prohibido si el sector ya tiene entradas publicadas. */
  async function regenerateSeats(
    db: Queryable,
    section: SectionRow,
    grid: { rows: number; perRow: number },
  ): Promise<number> {
    const used = await db.query("select 1 from ticket_types where section_id = $1 limit 1", [
      section.id,
    ]);
    if ((used.rowCount ?? 0) > 0) {
      throw AppError.conflict(
        "SECTION_HAS_TICKET_TYPES",
        "No se pueden regenerar las butacas de un sector con entradas publicadas",
      );
    }
    await db.query("delete from venue_seats where section_id = $1", [section.id]);
    const seats = seatGrid({
      rows: grid.rows,
      perRow: grid.perRow,
      x: section.shape_x + SEAT_PADDING,
      y: section.shape_y + SEAT_PADDING,
      w: Math.max(10, section.shape_w - SEAT_PADDING * 2),
      h: Math.max(10, section.shape_h - SEAT_PADDING * 2),
    });
    await db.query(
      `insert into venue_seats (id, section_id, row_label, seat_number, x, y)
       select gen_random_uuid(), $1, s.row, s.number, s.x, s.y
       from jsonb_to_recordset($2::jsonb) as s (row text, number int, x numeric, y numeric)`,
      [section.id, JSON.stringify(seats)],
    );
    return seats.length;
  }

  return {
    list() {
      return cache.get("venues", async () => {
        const result = await pool.query<VenueRow>(`${VENUES_SQL} group by v.id order by v.name`);
        return result.rows.map(toVenueDto);
      });
    },

    get: (id) => findVenue(pool, id),

    async create(input) {
      const id = newId();
      await pool.query(
        `insert into venues (id, name, city, address, capacity, map_width, map_height)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          input.name,
          input.city,
          input.address,
          input.capacity,
          input.mapWidth ?? 1000,
          input.mapHeight ?? 760,
        ],
      );
      await cache.invalidate();
      return findVenue(pool, id);
    },

    async update(id, input) {
      const result = await pool.query(
        `update venues set name = $2, city = $3, address = $4, capacity = $5,
           map_width = coalesce($6, map_width), map_height = coalesce($7, map_height),
           updated_at = now()
         where id = $1`,
        [
          id,
          input.name,
          input.city,
          input.address,
          input.capacity,
          input.mapWidth ?? null,
          input.mapHeight ?? null,
        ],
      );
      if (result.rowCount === 0) throw AppError.notFound("El recinto no existe");
      await cache.invalidate();
      return findVenue(pool, id);
    },

    async remove(id) {
      try {
        const result = await pool.query("delete from venues where id = $1", [id]);
        if (result.rowCount === 0) throw AppError.notFound("El recinto no existe");
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw AppError.conflict("VENUE_IN_USE", "El recinto tiene fechas de eventos asociadas");
        }
        throw error;
      }
      await cache.invalidate();
    },

    async createSection(input) {
      const section = await withTransaction(pool, async (client) => {
        await findVenue(client, input.venueId);
        const id = newId();
        const result = await client.query<SectionRow>(
          `insert into venue_sections
             (id, venue_id, name, kind, capacity, sort_order, shape_x, shape_y, shape_w, shape_h)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
          [
            id,
            input.venueId,
            input.name,
            input.kind,
            input.capacity,
            input.sortOrder,
            input.shape.x,
            input.shape.y,
            input.shape.w,
            input.shape.h,
          ],
        );
        const row = result.rows[0]!;
        if (input.kind === "seated" && input.seatGrid) {
          await regenerateSeats(client, row, input.seatGrid);
        }
        return syncSeatedCapacity(client, row);
      });
      await cache.invalidate();
      return toSectionDto(section);
    },

    async updateSection(id, input) {
      const section = await withTransaction(pool, async (client) => {
        const current = await findSection(client, id, true);
        if (current.kind !== input.kind) {
          const used = await client.query(
            "select 1 from ticket_types where section_id = $1 limit 1",
            [id],
          );
          if ((used.rowCount ?? 0) > 0) {
            throw AppError.conflict(
              "SECTION_HAS_TICKET_TYPES",
              "No se puede cambiar el tipo de un sector con entradas publicadas",
            );
          }
        }
        const result = await client.query<SectionRow>(
          `update venue_sections set name = $2, kind = $3, capacity = $4, sort_order = $5,
             shape_x = $6, shape_y = $7, shape_w = $8, shape_h = $9
           where id = $1 returning *`,
          [
            id,
            input.name,
            input.kind,
            input.capacity,
            input.sortOrder,
            input.shape.x,
            input.shape.y,
            input.shape.w,
            input.shape.h,
          ],
        );
        const row = result.rows[0]!;
        if (input.kind === "general") {
          await client.query("delete from venue_seats where section_id = $1", [id]);
        } else if (input.seatGrid) {
          await regenerateSeats(client, row, input.seatGrid);
        }
        return syncSeatedCapacity(client, row);
      });
      await cache.invalidate();
      return toSectionDto(section);
    },

    async removeSection(id) {
      try {
        const result = await pool.query("delete from venue_sections where id = $1", [id]);
        if (result.rowCount === 0) throw AppError.notFound("El sector no existe");
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw AppError.conflict(
            "SECTION_HAS_TICKET_TYPES",
            "El sector tiene entradas publicadas en alguna fecha",
          );
        }
        throw error;
      }
      await cache.invalidate();
    },

    async seats(sectionId) {
      await findSection(pool, sectionId);
      const result = await pool.query<{
        id: string;
        section_id: string;
        row_label: string;
        seat_number: number;
        x: string;
        y: string;
        blocked: boolean;
      }>(
        `select id, section_id, row_label, seat_number, x, y, blocked from venue_seats
         where section_id = $1 order by row_label, seat_number`,
        [sectionId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sectionId: row.section_id,
        row: row.row_label,
        number: row.seat_number,
        x: Number(row.x),
        y: Number(row.y),
        blocked: row.blocked,
      }));
    },

    async setSeatBlocked(seatId, blocked) {
      const result = await pool.query("update venue_seats set blocked = $2 where id = $1", [
        seatId,
        blocked,
      ]);
      if (result.rowCount === 0) throw AppError.notFound("La butaca no existe");
      await cache.invalidate();
    },
  };
}
