import type { Logger } from "@shared/commons";
import { authGuards, createTokenVerifier } from "@shared/commons/auth";
import type { Pool } from "@shared/commons/db";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import { createAdminService } from "./admin/service.js";
import { type IdentityConfig, createAuthService } from "./auth/service.js";
import type { KeyStore } from "./crypto/keys.js";
import { registerRoutes } from "./routes.js";

export interface AppDependencies {
  logger: Logger;
  pool: Pool;
  keys: KeyStore;
  config: IdentityConfig;
  readinessChecks?: Record<string, ReadinessCheck>;
}

/** Construye la app sin abrir puertos: los tests la usan con `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    // Solo el gateway (red interna) fija X-Forwarded-For: así `request.ip` es la IP real.
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 16 * 1024,
  });

  // identity verifica sus propios tokens con sus claves (sin pedir su JWKS por HTTP).
  const guards = authGuards(createTokenVerifier({ getKey: deps.keys.getKey }));
  registerRoutes(app, {
    auth: createAuthService({
      pool: deps.pool,
      keys: deps.keys,
      config: deps.config,
      logger: deps.logger,
    }),
    admin: createAdminService(deps.pool),
    keys: deps.keys,
    guards,
  });
  return app;
}
