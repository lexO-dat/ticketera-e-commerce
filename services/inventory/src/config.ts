import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** JWKS de identity (tokens de acceso). */
  JWKS_URL: z.url(),
  /** JWKS de queue (tokens de admisión de la fila, ADR-06). */
  QUEUE_JWKS_URL: z.url(),
  CATALOG_URL: z.url(),
  /** ADR-03: reserva exclusiva de 10 minutos. */
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /** Período del barrido de reservas vencidas. */
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  /** Micro-caché de la disponibilidad pública (absorbe miles de consultas por segundo). */
  AVAILABILITY_CACHE_MS: z.coerce.number().int().min(0).max(10_000).default(1_000),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
