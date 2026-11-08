import type { FastifyRequest } from "fastify";
import { AppError, ErrorCode, isAppError } from "../errors.js";
import { safeEqual } from "../ids.js";
import type { Logger } from "../logger.js";
import { CircuitBreaker, retry } from "../retry.js";

/**
 * Autenticación entre servicios (`/internal/*`): un secreto compartido por despliegue en la cabecera
 * `x-internal-token`. El gateway nunca enruta `/internal/*` y descarta esa cabecera si la manda un
 * cliente, así que solo la red de servicios puede usar estos endpoints.
 */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

export function internalGuard(token: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const presented = request.headers[INTERNAL_TOKEN_HEADER];
    if (typeof presented !== "string" || !safeEqual(presented, token)) {
      // 404: no revela que el endpoint existe.
      throw AppError.notFound("Ruta no encontrada");
    }
  };
}

export interface ServiceResponse<T> {
  status: number;
  body: T;
}

export interface ServiceRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Hace la solicitud idempotente (POST reintentable). */
  idempotencyKey?: string;
  /** Códigos 4xx que el llamador maneja (no se convierten en error). */
  accept?: number[];
}

export interface ServiceClient {
  request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: ServiceRequestOptions,
  ): Promise<ServiceResponse<T>>;
}

class TransientError extends Error {}

/**
 * Cliente HTTP entre servicios: timeout, reintentos con backoff + jitter (solo si la operación es
 * idempotente) y _circuit breaker_ (AGENTS §8). Un 4xx inesperado se propaga como el mismo
 * AppError (código, motivo y detalle del problema RFC 9457); un 5xx o la red caída, como 503.
 */
export function createServiceClient(options: {
  name: string;
  baseUrl: string;
  internalToken?: string;
  logger: Logger;
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
}): ServiceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const breaker = new CircuitBreaker({
    name: options.name,
    failureThreshold: 5,
    resetTimeoutMs: 10_000,
  });

  return {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      request: ServiceRequestOptions = {},
    ): Promise<ServiceResponse<T>> {
      const headers: Record<string, string> = { accept: "application/json", ...request.headers };
      if (options.internalToken) headers[INTERNAL_TOKEN_HEADER] = options.internalToken;
      if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;
      if (request.body !== undefined) headers["content-type"] = "application/json";
      const retriable =
        method === "GET" ||
        method === "PUT" ||
        method === "DELETE" ||
        Boolean(request.idempotencyKey);

      let result: ServiceResponse<T & { code?: string; reason?: string; detail?: string }>;
      try {
        result = await breaker.execute(() =>
          retry(
            async () => {
              let response: Response;
              try {
                response = await fetchImpl(new URL(path, options.baseUrl), {
                  method,
                  headers,
                  ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
                  signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
                });
              } catch (error) {
                throw new TransientError(error instanceof Error ? error.message : String(error));
              }
              const text = await response.text();
              const body = (text ? JSON.parse(text) : {}) as T & {
                code?: string;
                reason?: string;
                detail?: string;
              };
              if (response.status >= 500)
                throw new TransientError(`${options.name} respondió ${response.status}`);
              // Un 4xx es una respuesta válida del servicio: no cuenta como falla del circuito.
              return { status: response.status, body };
            },
            {
              attempts: retriable ? (options.attempts ?? 3) : 1,
              baseDelayMs: 100,
              maxDelayMs: 1_000,
              shouldRetry: (error) => error instanceof TransientError,
            },
          ),
        );
      } catch (error) {
        if (isAppError(error)) throw error;
        options.logger.warn({ err: error, service: options.name, path }, "servicio no disponible");
        throw AppError.unavailable(`${options.name} no está disponible; intenta en un momento`, 5);
      }
      if (result.status >= 400 && !request.accept?.includes(result.status)) {
        const code = result.body.code as ErrorCode | undefined;
        throw new AppError(code && code in ErrorCode ? code : ErrorCode.INTERNAL, undefined, {
          reason: result.body.reason,
          detail: result.body.detail,
        });
      }
      return result;
    },
  };
}
