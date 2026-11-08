import type { Logger } from "@shared/commons";
import { type TokenVerifier, authGuards } from "@shared/commons/auth";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import type { QueueService } from "./queue.js";
import { registerRoutes } from "./routes.js";
import type { AdmissionSigner } from "./tokens.js";

export interface AppDependencies {
  logger: Logger;
  queue: QueueService;
  signer: AdmissionSigner;
  verifyToken: TokenVerifier;
  readinessChecks?: Record<string, ReadinessCheck>;
}

/** Construye la app sin abrir puertos: los tests la usan con `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 4 * 1024,
  });
  registerRoutes(app, {
    queue: deps.queue,
    signer: deps.signer,
    guards: authGuards(deps.verifyToken),
  });
  return app;
}
