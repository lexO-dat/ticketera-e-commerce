import type { Logger } from "@shared/commons";
import { type TokenVerifier, authGuards } from "@shared/commons/auth";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import type { TicketQr } from "./qr.js";
import { registerRoutes } from "./routes.js";
import type { TicketService } from "./service.js";

export interface AppDependencies {
  logger: Logger;
  tickets: TicketService;
  qr: TicketQr;
  verifyToken: TokenVerifier;
  readinessChecks?: Record<string, ReadinessCheck>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 8 * 1024,
  });
  registerRoutes(app, { tickets: deps.tickets, qr: deps.qr, guards: authGuards(deps.verifyToken) });
  return app;
}
