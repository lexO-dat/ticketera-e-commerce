import { readFile } from "node:fs/promises";
import type { Logger } from "@shared/commons";
import { type Pool, withTransaction } from "@shared/commons/db";

const SEED_LOCK = 7340112501n;

/** Carga `seed/demo.sql` (promociones del prototipo) solo si no hay ninguna. */
export async function seedDemoData(pool: Pool, file: string, logger: Logger): Promise<boolean> {
  const sql = await readFile(file, "utf8");
  return withTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [SEED_LOCK]);
    const existing = await client.query("select 1 from promo_codes limit 1");
    if ((existing.rowCount ?? 0) > 0) return false;
    await client.query(sql);
    logger.warn("sin promociones: datos de demostración cargados (SEED_DEMO_DATA)");
    return true;
  });
}
