import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import { AppError, ErrorCode, type Logger, toProblem } from "@shared/commons";
import {
  ADMISSION_HEADER,
  type AdmissionVerifier,
  type TokenVerifier,
  admissionRequired,
  bearerToken,
} from "@shared/commons/auth";
import { type ReadinessCheck, createServer } from "@shared/commons/http";
import type { Redis } from "@shared/commons/redis";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "./config.js";
import { createRateLimiter, defaultRules } from "./rate-limit.js";
import { upstreamRoutes } from "./routes.js";

export interface AppDependencies {
  logger: Logger;
  config: Pick<
    Config,
    | "IDENTITY_URLS"
    | "CATALOG_URLS"
    | "QUEUE_URLS"
    | "INVENTORY_URLS"
    | "ORDERS_URLS"
    | "PAYMENTS_URLS"
    | "TICKETS_URLS"
    | "CORS_ORIGINS"
    | "TRUST_PROXY"
    | "UPSTREAM_TIMEOUT_MS"
    | "RATE_LIMIT_PER_MINUTE"
  >;
  redis: Redis;
  verifyToken: TokenVerifier;
  /** Token de admisión de la fila (ADR-06); sin él, el gateway no lo pre-verifica. */
  verifyAdmission?: AdmissionVerifier;
  readinessChecks?: Record<string, ReadinessCheck>;
}

// Cabeceras que solo el gateway puede fijar: se descartan si vienen del cliente.
const SPOOFABLE_HEADERS = ["x-user-id", "x-user-roles", "x-internal-token"];

function sendUpstreamError(reply: FastifyReply, error: Error): void {
  const timedOut = /timeout/i.test(error.name) || /timeout/i.test(error.message);
  const problem = toProblem(
    new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, undefined, {
      detail: timedOut
        ? "El servicio tardó demasiado en responder"
        : "Servicio no disponible temporalmente",
      retryAfterSeconds: 5,
    }),
    reply.request.id,
  );
  reply.log.warn({ err: error }, "gateway: error con el servicio");
  void reply
    .status(timedOut ? 504 : 503)
    .header("retry-after", "5")
    .type("application/problem+json")
    .send({ ...problem, status: timedOut ? 504 : 503 });
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config } = deps;
  const app = createServer({
    logger: deps.logger,
    readinessChecks: deps.readinessChecks ?? {},
    trustProxy: config.TRUST_PROXY,
    bodyLimitBytes: 1024 * 1024,
  });

  // El API es solo con Bearer (sin cookies), así que no es vulnerable a CSRF. CORS solo para los
  // orígenes de navegador declarados (p. ej. la app de validación).
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-request-id",
      "x-admission-token",
    ],
    exposedHeaders: [
      "x-request-id",
      "retry-after",
      "ratelimit-limit",
      "ratelimit-remaining",
      "ratelimit-reset",
    ],
    maxAge: 600,
  });

  const rateLimit = createRateLimiter(
    deps.redis,
    defaultRules(config.RATE_LIMIT_PER_MINUTE),
    deps.logger,
  );
  app.addHook("onRequest", async (request, reply) => {
    for (const header of SPOOFABLE_HEADERS) delete request.headers[header];
    // Un token inválido se rechaza aquí, antes de consumir a los servicios.
    const token = bearerToken(request);
    if (token) request.user = await deps.verifyToken(token);
    // Turno de la fila: firma, vigencia y que sea del mismo usuario. El servicio comprueba además
    // el evento y que el jti siga vigente (permite expulsar).
    const admission = request.headers[ADMISSION_HEADER];
    if (typeof admission === "string" && admission && deps.verifyAdmission) {
      const verified = await deps.verifyAdmission(admission);
      if (verified.userId !== request.user?.id) {
        throw admissionRequired("El turno de la fila no corresponde a tu sesión");
      }
    }
    await rateLimit(request, reply);
  });

  for (const route of upstreamRoutes(config)) {
    // Round-robin entre las réplicas del servicio (ADR-01: contenedores sin estado).
    let next = 0;
    const pickUpstream = () => route.upstreams[next++ % route.upstreams.length]!;
    await app.register(proxy, {
      upstream: route.upstreams[0]!,
      prefix: route.prefix,
      rewritePrefix: route.rewritePrefix,
      httpMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      undici: {
        connections: 128,
        pipelining: 1,
        headersTimeout: config.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: config.UPSTREAM_TIMEOUT_MS,
      },
      preHandler: async (request) => {
        if (!route.roles) return;
        if (!request.user) throw AppError.unauthenticated("Inicia sesión para continuar");
        if (!route.roles.some((role) => request.user?.roles.includes(role))) {
          throw AppError.forbidden("No tienes permisos para esta acción");
        }
      },
      replyOptions: {
        timeout: config.UPSTREAM_TIMEOUT_MS,
        ...(route.upstreams.length > 1 ? { getUpstream: pickUpstream } : {}),
        rewriteRequestHeaders: (request, headers) => {
          const next = { ...headers };
          // API solo-Bearer: las cookies del navegador nunca llegan a los servicios.
          delete next.cookie;
          next["x-request-id"] = request.id;
          next["x-forwarded-for"] = request.ip;
          next["x-forwarded-proto"] = "https";
          return next;
        },
        onError: (reply, { error }) => sendUpstreamError(reply as FastifyReply, error),
      },
    });
  }

  return app;
}
