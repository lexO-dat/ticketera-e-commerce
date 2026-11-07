import { readFile } from "node:fs/promises";
import type { Logger } from "@shared/commons";
import { type Pool, withTransaction } from "@shared/commons/db";

/** Lock de sesión para que dos réplicas no carguen el seed a la vez. */
const SEED_LOCK = 7340112301n;

/**
 * Carga `seed/demo.sql` (datos del prototipo) solo si el catálogo está vacío. Idempotente y
 * seguro con varias réplicas arrancando a la vez.
 */
export async function seedDemoData(pool: Pool, file: string, logger: Logger): Promise<boolean> {
  const sql = await readFile(file, "utf8");
  return withTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [SEED_LOCK]);
    const existing = await client.query("select 1 from venues limit 1");
    if ((existing.rowCount ?? 0) > 0) return false;
    await client.query(sql);
    logger.warn("catálogo vacío: datos de demostración cargados (SEED_DEMO_DATA)");
    return true;
  });
}
