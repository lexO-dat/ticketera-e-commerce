const CLP = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

export function money(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return CLP.format(Number.isFinite(n) ? n : 0);
}

export function plainNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("es-CL").format(value ?? 0);
}

/**
 * Hora de Chile siempre, también en el render del servidor (el contenedor corre en UTC): si no,
 * un show a las 21:00 se mostraría como 00:00 del día siguiente.
 */
export const TIME_ZONE = "America/Santiago";

const DATE_LONG = new Intl.DateTimeFormat("es-CL", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

const DATE_SHORT = new Intl.DateTimeFormat("es-CL", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

// Reloj de 24 h ("21:00 hrs"), no "09:00 p. m. hrs".
const TIME = new Intl.DateTimeFormat("es-CL", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function longDate(iso: string): string {
  return DATE_LONG.format(new Date(iso));
}

export function shortDate(iso: string): string {
  return DATE_SHORT.format(new Date(iso));
}

export function clock(iso: string): string {
  return TIME.format(new Date(iso));
}

export function dateAndTime(iso: string): string {
  return `${longDate(iso)} · ${clock(iso)} hrs`;
}

export function countdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  conciertos: "Conciertos",
  teatro: "Teatro",
  festivales: "Festivales",
  deportes: "Deportes",
  familia: "Familia",
};

export const CATEGORIES = ["conciertos", "teatro", "festivales", "deportes", "familia"] as const;
