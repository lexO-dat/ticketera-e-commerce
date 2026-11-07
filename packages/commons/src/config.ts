import { z } from "zod";

/** Variables comunes a todo servicio. Cada servicio extiende este esquema con las suyas. */
export const baseServiceEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_NAME: z.string().min(1),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type BaseServiceConfig = z.infer<typeof baseServiceEnv>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuración inválida:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Valida las variables de entorno al arrancar. Falla rápido con un mensaje legible que nunca
 * incluye los valores (podrían ser secretos).
 */
export function loadConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  env: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(raíz)"}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Booleano desde env: true/false/1/0/yes/no. */
export const envBoolean = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");
