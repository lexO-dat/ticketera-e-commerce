import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  /** JWKS de identity (tokens de acceso). */
  JWKS_URL: z.url(),
  /** catalog: dueño de la configuración de la fila por evento. */
  CATALOG_URL: z.url(),
  /** Clave privada Ed25519 (PKCS#8 PEM en base64) que firma los tokens de admisión. */
  ADMISSION_SIGNING_KEY: z
    .string()
    .transform((value) => Buffer.from(value, "base64").toString("utf8"))
    .refine((pem) => pem.includes("BEGIN PRIVATE KEY"), "debe ser un PEM PKCS#8 en base64"),
  ADMISSION_SIGNING_KID: z.string().min(1).max(64).default("queue-1"),
  /** Período del admisor (ADR-06: 1 s). */
  ADMIT_INTERVAL_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
  /** Sin consultar el estado por este tiempo, el turno se descarta al llegar al frente. */
  HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  CONFIG_CACHE_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
