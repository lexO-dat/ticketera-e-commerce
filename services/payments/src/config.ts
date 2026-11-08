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
  ORDERS_URL: z.url(),
  /** Adquirente (webpay-mock en desarrollo; Webpay real en producción). */
  WEBPAY_URL: z.url(),
  WEBPAY_API_KEY_ID: z.string().min(1),
  WEBPAY_API_KEY_SECRET: z.string().min(16),
  /** Solo con webpay-mock: envía el email del pagador para que decida (ADR-07). */
  WEBPAY_SEND_MOCK_PAYER_EMAIL: envBoolean.default(true),
  /** return_url fija registrada en el adquirente (pasa por Nginx → gateway → payments). */
  PAYMENT_RETURN_URL: z.url().default("https://localhost:8443/api/payments/return"),
  PUBLIC_WEB_URL: z.url().default("https://localhost:8443"),
  /** Antifraude básico. */
  MAX_PAYMENT_AMOUNT: z.coerce.bigint().default(5_000_000n),
  MAX_ATTEMPTS_PER_ORDER: z.coerce.number().int().min(1).max(10).default(3),
  EXPIRY_GRACE_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
  EXPIRER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  RECONCILER_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfig(schema, env);
}
