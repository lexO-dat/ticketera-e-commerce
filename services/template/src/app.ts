import { createServer, type ReadinessCheck } from "@shared/commons/http";
import type { Logger } from "@shared/commons";
import type { FastifyInstance } from "fastify";
import pkg from "../package.json" with { type: "json" };
import { registerNotesRoutes } from "./notes/routes.js";
import type { NotesService } from "./notes/service.js";

export interface AppDependencies {
  serviceName: string;
  logger: Logger;
  notes: NotesService;
  readinessChecks?: Record<string, ReadinessCheck>;
}

/** Construye la app sin abrir puertos ni conexiones: los tests la usan con `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    // Solo el gateway / Nginx (red interna) puede fijar X-Forwarded-For.
    trustProxy: ["127.0.0.1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  });

  app.get("/v1/info", async () => ({ service: deps.serviceName, version: pkg.version }));
  registerNotesRoutes(app, deps.notes);

  return app;
}
