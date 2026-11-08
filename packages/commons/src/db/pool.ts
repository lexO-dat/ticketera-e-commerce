import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
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

/**
 * Nodos candidatos a primaria (ADR-01). `DATABASE_URL` puede traer respaldos en
 * `?failover_hosts=host:puerto,…` (como `target_session_attrs=read-write` de libpq): cada conexión
 * nueva verifica que el nodo acepte escrituras; si no responde, es una réplica o está aislado
 * (`default_transaction_read_only`), se pasa al siguiente. Así, tras promover la réplica, los
 * servicios la encuentran solos y nunca escriben en una primaria vieja que reaparece.
 */
export function parseFailoverHosts(connectionString: string): {
  connectionString: string;
  hosts: { host: string; port: number }[];
} {
  const url = new URL(connectionString);
  const extra = url.searchParams.get("failover_hosts");
  url.searchParams.delete("failover_hosts");
  const hosts = [{ host: url.hostname, port: Number(url.port || 5432) }];
  for (const entry of (extra ?? "").split(",").filter(Boolean)) {
    const [host, port] = entry.trim().split(":");
    hosts.push({ host: host!, port: Number(port || 5432) });
  }
  return { connectionString: url.toString(), hosts };
}

/** Plazo para abrir la conexión TCP a un nodo cuando hay respaldo. */
const CONNECT_TIMEOUT_MS = 1_500;

/** Cuánto se salta un nodo que no aceptó la conexión (dura más que un failover). */
const DOWN_FOR_MS = 10_000;

/** `pg.Client` que solo se queda conectado a un nodo que acepta escrituras. */
function failoverClient(hosts: { host: string; port: number }[], logger?: Logger) {
  let current = 0;
  /** Un nodo que no respondió se salta por un rato: no se vuelve a pagar su timeout. */
  const downUntil = new Array<number>(hosts.length).fill(0);
  const rotate = (from: number, reason: string, unreachable = false) => {
    if (unreachable) downUntil[from] = Date.now() + DOWN_FOR_MS;
    if (current !== from) return;
    // Siguiente nodo no marcado como caído (si todos lo están, el siguiente igual).
    let next = (from + 1) % hosts.length;
    for (let i = 0; i < hosts.length - 1 && downUntil[next]! > Date.now(); i++) {
      next = (next + 1) % hosts.length;
    }
    current = next;
    logger?.warn(
      { from: hosts[from], to: hosts[current], reason },
      "postgres: se busca la primaria en otro nodo",
    );
  };
  return class FailoverClient extends pg.Client {
    private readonly target: number;
    constructor(config?: pg.ClientConfig) {
      const target = current;
      // pg re-parsea `connectionString` y pisaría el host: se pasan los campos ya parseados.
      const { connectionString, ...rest } = config ?? {};
      const parsed = connectionString ? parseConnectionString(connectionString) : {};
      super({
        ...(parsed as pg.ClientConfig),
        ...rest,
        host: hosts[target]!.host,
        port: hosts[target]!.port,
        // Solo para abrir la conexión de este cliente: un nodo caído se descarta rápido (dentro de
        // Docker resolver el nombre de un contenedor muerto tarda ~5 s y conectar a su IP ~3 s).
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });
      this.target = target;
    }

    // @ts-expect-error: misma firma que pg.Client.connect (callback o promesa).
    override connect(callback?: (error?: Error) => void): Promise<void> | undefined {
      const done = (async () => {
        try {
          await super.connect();
        } catch (error) {
          rotate(this.target, "sin conexión", true);
          throw error;
        }
        const role = await super.query<{ standby: boolean; read_only: string }>(
          "select pg_is_in_recovery() as standby, current_setting('default_transaction_read_only') as read_only",
        );
        const row = role.rows[0]!;
        if (row.standby || row.read_only === "on") {
          rotate(this.target, row.standby ? "es réplica" : "aislado (solo lectura)");
          await this.end().catch(() => undefined);
          throw Object.assign(new Error("postgres: el nodo no acepta escrituras"), {
            code: "57P03", // cannot_connect_now: transitorio
          });
        }
      })();
      if (!callback) return done;
      done.then(
        () => callback(),
        (error: Error) => callback(error),
      );
      return undefined;
    }
  };
}

export function createPool(options: CreatePoolOptions): Pool {
  const { connectionString, hosts } = parseFailoverHosts(options.connectionString);
  const pool = new pg.Pool({
    connectionString,
    ...(hosts.length > 1
      ? { Client: failoverClient(hosts, options.logger) as unknown as typeof pg.Client }
      : {}),
    application_name: options.applicationName,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    // En pg-pool este plazo incluye esperar un cliente libre: en un peak la cola de espera es
    // normal, así que es holgado (el de abrir la conexión con respaldo es más corto, arriba).
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
