import { baseServiceEnv, loadConfig } from "@shared/commons";
import { z } from "zod";

const ratio = z.coerce.number().min(0).max(1).default(0);

const schema = baseServiceEnv.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Credenciales que exige el API (como Tbk-Api-Key-Id / Tbk-Api-Key-Secret). */
  WEBPAY_API_KEY_ID: z.string().min(1),
  WEBPAY_API_KEY_SECRET: z.string().min(16),
  /** URL pública del formulario de pago (detrás de Nginx). */
  WEBPAY_FORM_URL: z.url().default("https://localhost:8443/webpay/form"),
  /** Resultado para emails que no son @acceptme.com ni @rejectme.com. */
  WEBPAY_MOCK_DEFAULT_OUTCOME: z.enum(["accept", "reject"]).default("reject"),
  /** Modos de falla para pruebas de resiliencia (apagados por defecto). */
  WEBPAY_MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(30_000).default(0),
  WEBPAY_MOCK_COMMIT_LOSS_RATIO: ratio,
  WEBPAY_MOCK_ERROR_RATIO: ratio,
  TRANSACTION_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
