import { useMemo } from "react";

import { money } from "@/lib/format";
import { Caption, MetaText } from "@/components/kit/Text";

export type MapSection = {
  id: string;
  name: string;
  kind: string;
  capacity: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type MapSeat = {
  id: string;
  sectionId: string;
  row: string;
  number: number;
  x: number;
  y: number;
  unavailable: boolean;
};

export type MapTicket = {
  id: string;
  name: string;
  price: number;
  fee: number;
  capacity: number;
  sold: number;
  sectionId: string;
};

/* Layout constants (unidades del viewBox) */
const PITCH = 20;
const SEAT_R = 7;
const ROW_LABEL_W = 26;
const BOX_PAD = 14;
const SECTION_HEADER = 34;
const SECTION_GAP = 34;
const STAGE_H = 42;
const STAGE_GAP = 46;
const MARGIN_X = 28;
const MARGIN_TOP = 24;
const MARGIN_BOTTOM = 28;

type LaidOutSeat = MapSeat & { cx: number; cy: number };
type LaidOutSection = {
  section: MapSection;
  ticket?: MapTicket | undefined;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  labelY: number;
  rows: { label: string; y: number }[];
  seats: LaidOutSeat[];
};

function layout(sections: MapSection[], seats: MapSeat[], tickets: MapTicket[]) {
  const ticketBySection = new Map(tickets.map((t) => [t.sectionId, t]));
  const seated = sections.filter((s) => s.kind === "seated");

  // Agrupa asientos por sección y fila, ordenados de forma estable.
  const bySection = new Map<string, Map<string, MapSeat[]>>();
  for (const seat of seats) {
    const rows = bySection.get(seat.sectionId) ?? new Map<string, MapSeat[]>();
    const row = rows.get(seat.row) ?? [];
    row.push(seat);
    rows.set(seat.row, row);
    bySection.set(seat.sectionId, rows);
  }

  let maxCols = 0;
  const prepared = seated
    .map((section) => {
      const rowMap = bySection.get(section.id);
      if (!rowMap || rowMap.size === 0) return null;
      const rows = [...rowMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }))
        .map(([label, list]) => ({
          label,
          seats: [...list].sort((a, b) => a.number - b.number),
        }));
      maxCols = Math.max(maxCols, ...rows.map((r) => r.seats.length));
      return { section, rows, ticket: ticketBySection.get(section.id) };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  const gridW = maxCols * PITCH;
  const boxW = ROW_LABEL_W + gridW + BOX_PAD * 2;
  const width = boxW + MARGIN_X * 2;

  let y = MARGIN_TOP + STAGE_H + STAGE_GAP;
  const laidOut: LaidOutSection[] = [];

  for (const { section, rows, ticket } of prepared) {
    const boxH = rows.length * PITCH + BOX_PAD * 2;
    const boxX = MARGIN_X;
    const boxY = y + SECTION_HEADER;
    const rowsOut: { label: string; y: number }[] = [];
    const seatsOut: LaidOutSeat[] = [];

    rows.forEach((row, ri) => {
      const cy = boxY + BOX_PAD + PITCH / 2 + ri * PITCH;
      rowsOut.push({ label: row.label, y: cy });
      // Centra cada fila dentro de la grilla.
      const rowW = row.seats.length * PITCH;
      const startX = boxX + ROW_LABEL_W + BOX_PAD + (gridW - rowW) / 2;
      row.seats.forEach((seat, ci) => {
        seatsOut.push({ ...seat, cx: startX + PITCH / 2 + ci * PITCH, cy });
      });
    });

    laidOut.push({
      section,
      ticket,
      boxX,
      boxY,
      boxW,
      boxH,
      labelY: y + 20,
      rows: rowsOut,
      seats: seatsOut,
    });

    y = boxY + boxH + SECTION_GAP;
  }

  return { sections: laidOut, width, height: y - SECTION_GAP + MARGIN_BOTTOM };
}

export function SeatMap({
  sections,
  seats,
  tickets,
  selected,
  onToggleSeat,
  adminMode = false,
}: {
  sections: MapSection[];
  seats: MapSeat[];
  tickets: MapTicket[];
  width?: number;
  height?: number;
  selected: string[];
  onToggleSeat: (seat: MapSeat) => void;
  adminMode?: boolean;
}) {
  const model = useMemo(() => layout(sections, seats, tickets), [sections, seats, tickets]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  if (model.sections.length === 0) return null;

  return (
    <div className="grid gap-6">
      <div className="overflow-x-auto rounded-card bg-plaster p-4 md:p-6">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="mx-auto block h-auto w-full"
          style={{ minWidth: Math.min(model.width, 560) }}
          role="img"
          aria-label="Mapa de asientos"
        >
          {/* Escenario */}
          <rect
            x={model.width / 2 - Math.min(300, model.width * 0.4)}
            y={MARGIN_TOP}
            width={Math.min(600, model.width * 0.8)}
            height={STAGE_H}
            fill="#000000"
            rx={2}
          />
          <text
            x={model.width / 2}
            y={MARGIN_TOP + STAGE_H / 2 + 5}
            textAnchor="middle"
            fill="#ffffff"
            fontSize={14}
            letterSpacing={3}
          >
            ESCENARIO
          </text>

          {model.sections.map((s) => (
            <g key={s.section.id}>
              <text x={s.boxX} y={s.labelY} fontSize={15} fill="#000000">
                {s.section.name}
              </text>
              {s.ticket ? (
                <text
                  x={s.boxX + s.boxW}
                  y={s.labelY}
                  fontSize={13}
                  fill="#828282"
                  textAnchor="end"
                >
                  {money(s.ticket.price)}
                </text>
              ) : null}

              <rect
                x={s.boxX}
                y={s.boxY}
                width={s.boxW}
                height={s.boxH}
                fill="#ffffff"
                stroke="#bdbdbd"
                strokeWidth={1}
                rx={2}
              />

              {s.rows.map((row) => (
                <text
                  key={row.label}
                  x={s.boxX + BOX_PAD + ROW_LABEL_W - 8}
                  y={row.y + 4}
                  fontSize={10}
                  fill="#828282"
                  textAnchor="end"
                >
                  {row.label}
                </text>
              ))}

              {s.seats.map((seat) => {
                const isSelected = selectedSet.has(seat.id);
                const locked = seat.unavailable && !adminMode;
                return (
                  <circle
                    key={seat.id}
                    cx={seat.cx}
                    cy={seat.cy}
                    r={SEAT_R}
                    fill={isSelected ? "#71cc98" : seat.unavailable ? "#bdbdbd" : "#ffffff"}
                    stroke={isSelected ? "#000000" : seat.unavailable ? "#bdbdbd" : "#828282"}
                    strokeWidth={isSelected ? 1.4 : 0.9}
                    className={`transition-colors ${
                      locked ? "cursor-not-allowed" : "cursor-pointer hover:fill-linen"
                    }`}
                    onClick={() => {
                      if (locked) return;
                      onToggleSeat(seat);
                    }}
                  >
                    <title>{`${s.section.name} · Fila ${seat.row} · Asiento ${seat.number}`}</title>
                  </circle>
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <Legend color="#ffffff" label="Disponible" />
        <Legend color="#71cc98" label="Seleccionado" />
        <Legend color="#bdbdbd" label="No disponible" />
        <MetaText className="ml-auto inline">
          {seats.filter((s) => !s.unavailable).length} butacas disponibles
        </MetaText>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="size-3 rounded-pill border border-ash"
        style={{ backgroundColor: color }}
      />
      <Caption className="inline text-graphite">{label}</Caption>
    </span>
  );
}
