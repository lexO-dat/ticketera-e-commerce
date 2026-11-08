import type { Logger } from "@shared/commons";
import { type AdmissionVerifier, type TokenVerifier, authGuards } from "@shared/commons/auth";
import type { Pool } from "@shared/commons/db";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { Redis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import type { CatalogClient } from "./catalog-client.js";
import { createMicroCache } from "./micro-cache.js";
import { type ReservationService, createReservationService } from "./reservations.js";
import { registerRoutes } from "./routes.js";

export interface AppDependencies {
  logger: Logger;
  pool: Pool;
  redis: Redis;
  catalog: CatalogClient;
  verifyToken: TokenVerifier;
  verifyAdmission: AdmissionVerifier;
  reservationTtlSeconds?: number;
  availabilityCacheMs?: number;
  cachePrefix?: string;
  readinessChecks?: Record<string, ReadinessCheck>;
}

/** Construye la app sin abrir puertos: los tests la usan con `app.inject`. */
export function buildApp(deps: AppDependencies): {
  app: FastifyInstance;
  reservations: ReservationService;
} {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 16 * 1024,
  });
  const reservations = createReservationService({
    pool: deps.pool,
    redis: deps.redis,
    catalog: deps.catalog,
    logger: deps.logger,
    ...(deps.reservationTtlSeconds ? { ttlSeconds: deps.reservationTtlSeconds } : {}),
  });
  registerRoutes(app, {
    reservations,
    guards: authGuards(deps.verifyToken),
    verifyAdmission: deps.verifyAdmission,
    cache: createMicroCache({
      redis: deps.redis,
      ttlMs: deps.availabilityCacheMs ?? 1_000,
      logger: deps.logger,
      ...(deps.cachePrefix ? { prefix: deps.cachePrefix } : {}),
    }),
  });
  return { app, reservations };
}
