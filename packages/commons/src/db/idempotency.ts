import { AppError, ErrorCode } from "../errors.js";
import { sha256Hex } from "../ids.js";
import type { Pool } from "./pool.js";

/**
 * Idempotencia de operaciones que mueven dinero o crean recursos (docs/services/payments.md §6):
 * misma clave + misma solicitud → misma respuesta guardada; misma clave + otra solicitud → 422;
 * una ejecución en curso con la misma clave → 409 (reintentar). Si el proceso muere a mitad de la
 * operación, el lock vence y un reintento la retoma (la operación debe tolerar repetirse).
 *
 * Tabla (copiar en la migración del servicio):
 */
export const IDEMPOTENCY_SQL = `
create table if not exists idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  status_code integer,
  response jsonb,
  locked_until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);`;

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

/** Hash estable de la solicitud (orden de claves normalizado). */
export function requestHash(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return sha256Hex(JSON.stringify(stable(value) ?? null));
}

const KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/;

export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw AppError.validation([
      {
        path: "Idempotency-Key",
        message: "Cabecera Idempotency-Key obligatoria (8–128 caracteres)",
      },
    ]);
  }
  return key;
}

export async function withIdempotency<T>(
  pool: Pool,
  request: { scope: string; key: string; hash: string; lockMs?: number },
  run: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const lockMs = request.lockMs ?? 30_000;
  const claimed = await pool.query(
    `insert into idempotency_keys (scope, key, request_hash, locked_until)
     values ($1, $2, $3, now() + make_interval(secs => $4 / 1000.0))
     on conflict (scope, key) do nothing`,
    [request.scope, request.key, request.hash, lockMs],
  );

  if (claimed.rowCount === 0) {
    const existing = await pool.query<{
      request_hash: string;
      status_code: number | null;
      response: T | null;
      locked: boolean;
    }>(
      `select request_hash, status_code, response, locked_until > now() as locked
       from idempotency_keys where scope = $1 and key = $2`,
      [request.scope, request.key],
    );
    const row = existing.rows[0];
    if (!row) return withIdempotency(pool, request, run); // se liberó entre medio
    if (row.request_hash !== request.hash) {
      throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, undefined, {
        detail: "La clave de idempotencia ya se usó con otra solicitud",
      });
    }
    if (row.status_code !== null) {
      return { statusCode: row.status_code, body: row.response as T, replayed: true };
    }
    if (row.locked) {
      throw new AppError(ErrorCode.CONFLICT, undefined, {
        reason: "IDEMPOTENCY_IN_PROGRESS",
        detail: "La misma solicitud se está procesando; reintenta en un momento",
        retryAfterSeconds: 1,
      });
    }
    // Lock vencido (el proceso anterior murió): se retoma.
    const takeover = await pool.query(
      `update idempotency_keys set locked_until = now() + make_interval(secs => $3 / 1000.0)
       where scope = $1 and key = $2 and status_code is null and locked_until <= now()`,
      [request.scope, request.key, lockMs],
    );
    if (takeover.rowCount === 0) return withIdempotency(pool, request, run);
  }

  try {
    const result = await run();
    await pool.query(
      `update idempotency_keys set status_code = $3, response = $4
       where scope = $1 and key = $2`,
      [request.scope, request.key, result.statusCode, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  } catch (error) {
    // Sin respuesta guardada: un reintento con la misma clave vuelve a intentar.
    await pool
      .query("delete from idempotency_keys where scope = $1 and key = $2 and status_code is null", [
        request.scope,
        request.key,
      ])
      .catch(() => undefined);
    throw error;
  }
}
