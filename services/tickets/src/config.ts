import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWKS_URL: z.url(),
  CATALOG_URL: z.url(),
  /** Secreto compartido de los endpoints /internal (notifications). */
  INTERNAL_API_TOKEN: z.string().min(24),
  /** Clave privada Ed25519 (PKCS#8 PEM en base64) que firma el QR de las entradas. */
  TICKET_SIGNING_KEY: z
    .string()
    .transform((value) => Buffer.from(value, "base64").toString("utf8"))
    .refine((pem) => pem.includes("BEGIN PRIVATE KEY"), "debe ser un PEM PKCS#8 en base64"),
  TICKET_SIGNING_KID: z.string().min(1).max(64).default("tickets-1"),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
