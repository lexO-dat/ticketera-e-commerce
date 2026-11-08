import { baseServiceEnv, envBoolean, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWKS_URL: z.url(),
  /** Secreto compartido de los endpoints /internal (autenticación entre servicios). */
  INTERNAL_API_TOKEN: z.string().min(24),
  INVENTORY_URL: z.url(),
  CATALOG_URL: z.url(),
  PAYMENTS_URL: z.url(),
  TICKETS_URL: z.url(),
  /** El carro vive en Redis (ADR-01); se borra tras este tiempo sin cambios. */
  CART_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  /** Carga los códigos de descuento del prototipo si no hay ninguno. */
  SEED_DEMO_DATA: envBoolean.default(false),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
