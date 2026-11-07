import pg from "pg";
import type { Logger } from "pino";
import { retry } from "../retry.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

// `bigint` (int8) como BigInt de JS: los montos en CLP nunca pasan por `number`.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value));

export interface CreatePoolOptions {
  connectionString: string;
  /** Nombre visible en `pg_stat_activity`. */
  applicationName: string;
  max?: number;
  /** Corta consultas colgadas (ms). */
  statementTimeoutMs?: number;
  logger?: Logger;
}

export function createPool(options: CreatePoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    // Evita transacciones abiertas indefinidamente que retienen bloqueos (ADR-03).
    idle_in_transaction_session_timeout: 30_000,
  });
  pool.on("error", (error) =>
    options.logger?.error({ err: error }, "postgres: error en cliente inactivo"),
  );
  return pool;
}

/** Espera a que la BD acepte conexiones (arranque en docker compose). */
export async function waitForDatabase(pool: Pool, attempts = 20): Promise<void> {
  await retry(() => pool.query("select 1"), { attempts, baseDelayMs: 250, maxDelayMs: 3_000 });
}

/** Errores de concurrencia que se resuelven reintentando la transacción completa. */
const RETRYABLE_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    RETRYABLE_SQLSTATES.has(String((error as { code: unknown }).code))
  );
}

export interface TransactionOptions {
  isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  /** Intentos ante `serialization_failure` / `deadlock_detected`. */
  attempts?: number;
}

/**
 * Ejecuta `fn` dentro de una transacción. Si `fn` lanza, hace ROLLBACK. Reintenta la transacción
 * completa ante conflictos de serialización o _deadlocks_ (por eso `fn` no debe tener efectos
 * fuera de la BD: publicar eventos se hace vía outbox).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { isolationLevel = "READ COMMITTED", attempts = 3 } = options;
  return retry(
    async () => {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    { attempts, baseDelayMs: 20, maxDelayMs: 500, shouldRetry: isRetryableTransactionError },
  );
}
