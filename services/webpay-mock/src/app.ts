import formbody from "@fastify/formbody";
import type { Logger } from "@shared/commons";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { Redis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { type MockOptions, registerRoutes } from "./routes.js";
import { createStore } from "./store.js";

export interface AppDependencies {
  logger: Logger;
  redis: Redis;
  options: MockOptions;
  ttlSeconds?: number;
  readinessChecks?: Record<string, ReadinessCheck>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 8 * 1024,
  });
  void app.register(formbody);
  void app.after(() => {
    registerRoutes(app, createStore(deps.redis, deps.ttlSeconds ?? 86_400), deps.options);
  });
  return app;
}
