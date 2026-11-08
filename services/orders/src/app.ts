import type { Logger } from "@shared/commons";
import { type TokenVerifier, authGuards } from "@shared/commons/auth";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { FastifyInstance } from "fastify";
import type { Cart } from "./cart.js";
import { registerRoutes } from "./routes.js";
import type { OrderService } from "./service.js";

export interface AppDependencies {
  logger: Logger;
  orders: OrderService;
  cart: Cart;
  verifyToken: TokenVerifier;
  internalToken: string;
  readinessChecks?: Record<string, ReadinessCheck>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    bodyLimitBytes: 32 * 1024,
  });
  registerRoutes(app, {
    orders: deps.orders,
    cart: deps.cart,
    guards: authGuards(deps.verifyToken),
    internalToken: deps.internalToken,
  });
  return app;
}
