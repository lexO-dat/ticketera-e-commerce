import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const urlList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

const schema = baseServiceEnv.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Réplicas de identity separadas por coma: el gateway balancea entre ellas (ADR-01). */
  IDENTITY_URLS: urlList,
  /** Orígenes de navegador permitidos (CORS) separados por coma; vacío = ninguno. */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  /** Proxies de confianza para X-Forwarded-For (Nginx / balanceador). */
  TRUST_PROXY: z
    .string()
    .default("127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Límite general por usuario (o IP si es anónimo) y minuto. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
