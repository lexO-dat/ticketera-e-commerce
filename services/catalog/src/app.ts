import multipart from "@fastify/multipart";
import type { Logger } from "@shared/commons";
import { type TokenVerifier, authGuards } from "@shared/commons/auth";
import type { Pool } from "@shared/commons/db";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import type { ReadCache } from "./cache.js";
import { createEventService } from "./events/service.js";
import { type SellableItemCatalog, defaultSellableCatalog } from "./items/registry.js";
import { createMediaService } from "./media/service.js";
import type { MetricsService } from "./metrics/service.js";
import { createProductService } from "./products/service.js";
import { registerRoutes } from "./routes.js";
import { createVenueService } from "./venues/service.js";

export interface AppDependencies {
  logger: Logger;
  pool: Pool;
  cache: ReadCache;
  verifyToken: TokenVerifier;
  mediaPublicPath: string;
  mediaMaxUploadBytes: number;
  publicMaxAgeSeconds?: number;
  items?: SellableItemCatalog;
  readinessChecks?: Record<string, ReadinessCheck>;
  metrics: MetricsService;
}

/** Construye la app sin abrir puertos: los tests la usan con `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    // Solo el gateway (red interna) fija X-Forwarded-For.
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 256 * 1024,
  });

  // Subidas: un solo archivo, sin campos extra; el tope se aplica mientras llega (no en memoria).
  void app.register(multipart, {
    limits: { fileSize: deps.mediaMaxUploadBytes, files: 1, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  });

  const media = createMediaService({ pool: deps.pool, publicPath: deps.mediaPublicPath });
  const shared = { pool: deps.pool, cache: deps.cache, media };
  void app.after(() => {
    registerRoutes(app, {
      pool: deps.pool,
      events: createEventService(shared),
      venues: createVenueService(shared),
      products: createProductService(shared),
      media,
      items: deps.items ?? defaultSellableCatalog(),
      metrics: deps.metrics,
      guards: authGuards(deps.verifyToken),
      publicMaxAgeSeconds: deps.publicMaxAgeSeconds ?? 5,
    });
  });
  return app;
}
