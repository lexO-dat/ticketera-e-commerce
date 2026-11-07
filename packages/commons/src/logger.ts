import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

/**
 * Rutas que nunca deben aparecer en logs (ASR04): credenciales, tokens y datos de pago.
 * pino las reemplaza por `[REDACTED]`.
 */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "newPassword",
  "*.newPassword",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "secret",
  "*.secret",
  "cardNumber",
  "*.cardNumber",
  "cvv",
  "*.cvv",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-admission-token"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
];

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions["level"];
  /** Salida legible (requiere instalar `pino-pretty`). En producción, JSON. */
  pretty?: boolean;
}

export function createLogger({
  service,
  level = "info",
  pretty = false,
}: CreateLoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(pretty ? { transport: { target: "pino-pretty", options: { singleLine: true } } } : {}),
  });
}
