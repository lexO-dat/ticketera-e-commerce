import { baseServiceEnv, envBoolean, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** JWKS de identity (normalmente a través del gateway o directo en la red interna). */
  JWKS_URL: z.url(),
  /** TTL de la caché de lectura pública (ADR-02: segundos). */
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  /** Prefijo público con que el navegador pide las imágenes (Nginx → gateway → catalog). */
  MEDIA_PUBLIC_PATH: z
    .string()
    .regex(/^\/[\w/-]*[^/]$/)
    .default("/api/catalog/media"),
  /** Tamaño máximo de una imagen subida, antes de procesarla. */
  MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(20 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  /** Carga los datos de demostración (seed/demo.sql) si el catálogo está vacío. */
  SEED_DEMO_DATA: envBoolean.default(false),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
