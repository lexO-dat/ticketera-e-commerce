import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const schema = baseServiceEnv
  .extend({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    AMQP_URL: z.url({ protocol: /^amqps?$/ }),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** 32 bytes en base64: cifra las claves privadas de firma en la BD. */
    KEY_ENCRYPTION_SECRET: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, "debe ser 32 bytes en base64"),
    /** Rotación de la clave de firma activa. */
    SIGNING_KEY_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(30),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** URL pública de la web, para los enlaces de verificación y recuperación. */
    PUBLIC_WEB_URL: z.url().default("https://localhost:8443"),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
    /** Crea un administrador al arrancar si no existe ninguno (primer despliegue / desarrollo). */
    BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  })
  .refine(
    (env) => Boolean(env.BOOTSTRAP_ADMIN_EMAIL) === Boolean(env.BOOTSTRAP_ADMIN_PASSWORD),
    "BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD van juntos",
  );

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
