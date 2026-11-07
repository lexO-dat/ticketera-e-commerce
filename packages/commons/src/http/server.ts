import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Logger } from "pino";
import { ZodError, type z } from "zod";
import { AppError, ErrorCode, isAppError, toProblem } from "../errors.js";

/** Comprobación de una dependencia para `/health/ready` (BD, Redis, broker...). */
export type ReadinessCheck = () => Promise<void>;

export interface CreateServerOptions {
  logger: Logger;
  /** Dependencias que deben responder para recibir tráfico. */
  readinessChecks?: Record<string, ReadinessCheck>;
  /** Tiempo máximo por comprobación. */
  readinessTimeoutMs?: number;
  bodyLimitBytes?: number;
  /** Proxies de confianza para `X-Forwarded-For` (el gateway / Nginx). */
  trustProxy?: FastifyServerOptions["trustProxy"];
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

declare module "fastify" {
  interface FastifyInstance {
    /** `false` mientras el servicio se apaga: `/health/ready` responde 503 y el balanceador lo saca. */
    acceptingTraffic: boolean;
  }
}

/**
 * Servidor Fastify con lo que todo servicio necesita:
 * - `x-request-id` propagado (o generado) y devuelto en la respuesta.
 * - Errores como `application/problem+json` (RFC 9457) sin filtrar internos.
 * - `GET /health/live` (el proceso vive) y `GET /health/ready` (puede atender: dependencias OK).
 */
export function createServer(options: CreateServerOptions): FastifyInstance {
  const app = Fastify({
    // pino 10 tipa `msgPrefix`; Fastify espera su interfaz base (compatible en runtime).
    loggerInstance: options.logger as FastifyBaseLogger,
    bodyLimit: options.bodyLimitBytes ?? 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: false,
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.decorate("acceptingTraffic", true);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = normalizeError(error);
    if (appError.status >= 500) {
      request.log.error({ err: error }, "error no controlado");
    } else {
      request.log.info({ code: appError.code, reason: appError.reason }, "solicitud rechazada");
    }
    if (appError.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(appError.retryAfterSeconds));
    }
    return reply
      .status(appError.status)
      .type("application/problem+json")
      .send(toProblem(appError, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .type("application/problem+json")
      .send(toProblem(AppError.notFound("Ruta no encontrada"), request.id));
  });

  app.get("/health/live", { logLevel: "silent" }, async () => ({ status: "ok" }));

  app.get("/health/ready", { logLevel: "silent" }, async (_request, reply) => {
    if (!app.acceptingTraffic) {
      return reply.status(503).send({ status: "shutting_down", checks: {} });
    }
    const timeoutMs = options.readinessTimeoutMs ?? 2_000;
    const entries = Object.entries(options.readinessChecks ?? {});
    const results = await Promise.all(
      entries.map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeoutMs);
          return [name, "ok"] as const;
        } catch (error) {
          app.log.warn({ err: error, check: name }, "readiness: dependencia no disponible");
          return [name, "fail"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const healthy = results.every(([, status]) => status === "ok");
    return reply.status(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", checks });
  });

  return app;
}

function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) return zodToAppError(error);
  // Errores propios de Fastify (JSON inválido, body demasiado grande, content-type no soportado).
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = Number((error as { statusCode: unknown }).statusCode);
    if (statusCode === 413) return new AppError(ErrorCode.PAYLOAD_TOO_LARGE);
    if (statusCode >= 400 && statusCode < 500) {
      return new AppError(ErrorCode.VALIDATION, undefined, { detail: "Solicitud mal formada" });
    }
  }
  return new AppError(ErrorCode.INTERNAL, undefined, { cause: error });
}

export function zodToAppError(error: ZodError): AppError {
  return AppError.validation(
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

/** Valida datos de entrada con Zod en el borde del servicio; lanza `AppError` VALIDATION. */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(data);
  if (!result.success) throw zodToAppError(result.error);
  return result.data;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout tras ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
