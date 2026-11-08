import { getCookie, setCookie } from "@tanstack/react-start/server";

/**
 * Token de admisión de la fila (ADR-06) en cookie HttpOnly, como la sesión (ADR-08): el navegador
 * nunca lo ve; las server functions lo reenvían a inventory como `X-Admission-Token`.
 */
function cookieName(eventId: string): string {
  return `tk_adm_${eventId.replaceAll("-", "")}`;
}

export function storeAdmission(eventId: string, token: string, expiresAt: string): void {
  setCookie(cookieName(eventId), token, {
    httpOnly: true,
    secure: process.env["COOKIE_SECURE"] !== "false",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function readAdmission(eventId: string): string | undefined {
  return getCookie(cookieName(eventId)) || undefined;
}

/** Estado del turno que devuelve `queue` (contrato: openapi/queue.yaml). */
export type ApiTurnStatus = {
  eventId: string;
  state:
    | "NOT_REQUIRED"
    | "NONE"
    | "PREQUEUE"
    | "WAITING"
    | "ADMITTED"
    | "EXPIRED"
    | "COMPLETED"
    | "LEFT"
    | "ABANDONED";
  position: number | null;
  ahead: number | null;
  waiting: number;
  etaSeconds: number | null;
  opensAt: string | null;
  admissionToken: string | null;
  expiresAt: string | null;
  windowMinutes: number;
  message: string | null;
  retryAfterSeconds: number | null;
};
