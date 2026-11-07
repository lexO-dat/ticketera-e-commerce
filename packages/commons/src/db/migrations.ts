import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { sha256Hex } from "../ids.js";
import type { Pool } from "./pool.js";

/**
 * Migraciones SQL versionadas, solo hacia adelante. Archivos `NNNN_descripcion.sql` en orden
 * lexicográfico; cada uno se aplica en su propia transacción. Un _advisory lock_ evita que dos
 * réplicas del servicio migren a la vez, y el checksum detecta migraciones ya aplicadas que fueron
 * modificadas (eso nunca se hace: se crea una migración nueva).
 */

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Clave arbitraria pero fija para pg_advisory_lock (int8).
const MIGRATION_LOCK_KEY = 7_340_112_001n;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const versions = new Set<string>();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1]) throw new MigrationError(`Nombre de migración inválido: ${file}`);
    if (versions.has(match[1]))
      throw new MigrationError(`Versión de migración duplicada: ${match[1]}`);
    versions.add(match[1]);
    const sql = await readFile(join(directory, file), "utf8");
    migrations.push({ version: match[1], name: file, sql, checksum: sha256Hex(sql) });
  }
  return migrations;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  pool: Pool,
  directory: string,
  logger?: Logger,
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      "select version, name, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(
            `La migración ${migration.name} cambió después de aplicarse; crea una migración nueva`,
          );
        }
        result.skipped.push(migration.name);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationError(`Falló la migración ${migration.name}: ${String(error)}`);
      }
      result.applied.push(migration.name);
      logger?.info({ migration: migration.name }, "migración aplicada");
    }
    return result;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}
