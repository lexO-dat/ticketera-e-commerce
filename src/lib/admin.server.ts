import type { SupabaseClient } from "@supabase/supabase-js";

/** Verifica el rol admin usando el cliente autenticado (RLS del usuario). */
export async function assertAdmin(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
  return true;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Genera coordenadas de butacas en una grilla dentro del rectángulo del sector. */
export function seatGrid(opts: {
  rows: number;
  perRow: number;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const seats: { row_label: string; seat_number: number; x: number; y: number }[] = [];
  const stepX = opts.perRow > 1 ? opts.w / (opts.perRow - 1) : 0;
  const stepY = opts.rows > 1 ? opts.h / (opts.rows - 1) : 0;
  for (let r = 0; r < opts.rows; r += 1) {
    const label = String.fromCharCode(65 + (r % 26)) + (r >= 26 ? String(Math.floor(r / 26)) : "");
    for (let c = 0; c < opts.perRow; c += 1) {
      seats.push({
        row_label: label,
        seat_number: c + 1,
        x: Math.round(opts.x + (opts.perRow > 1 ? c * stepX : opts.w / 2)),
        y: Math.round(opts.y + (opts.rows > 1 ? r * stepY : opts.h / 2)),
      });
    }
  }
  return seats;
}
