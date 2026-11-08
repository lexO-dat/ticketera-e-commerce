import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";

/**
 * Cliente del API Gateway para las server functions (patrón BFF): el navegador nunca ve los
 * tokens; la web los guarda en cookies HttpOnly y llama al gateway desde el servidor.
 */

export function gatewayUrl(): string {
  return process.env["GATEWAY_URL"] ?? "http://127.0.0.1:3000";
}

/** Error del gateway con el cuerpo RFC 9457 ya interpretado. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

interface GatewayRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Multipart (subida de archivos); excluyente con `body`. */
  form?: FormData;
  accessToken?: string | undefined;
  /** Cabeceras adicionales permitidas (p. ej. `x-admission-token`). */
  headers?: Record<string, string>;
}

export async function gatewayFetch<T>(path: string, request: GatewayRequest = {}): Promise<T> {
  const headers: Record<string, string> = { ...request.headers, accept: "application/json" };
  // Con `form`, fetch fija el content-type multipart con su boundary.
  if (request.body !== undefined) headers["content-type"] = "application/json";
  if (request.accessToken) headers["authorization"] = `Bearer ${request.accessToken}`;
  // El gateway limita por IP: hay que reenviar la del navegador, no la del servidor web.
  const clientIp = safe(() => getRequestIP({ xForwardedFor: true }));
  if (clientIp) headers["x-forwarded-for"] = clientIp;
  const userAgent = safe(() => getRequestHeader("user-agent"));
  if (userAgent) headers["user-agent"] = userAgent;

  let response: Response;
  try {
    response = await fetch(new URL(path, gatewayUrl()), {
      method: request.method ?? "GET",
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      ...(request.form ? { body: request.form } : {}),
      signal: AbortSignal.timeout(request.form ? 30_000 : 10_000),
    });
  } catch {
    throw new GatewayError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      undefined,
      "El servicio no está disponible; intenta en un momento.",
    );
  }

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = (payload ?? {}) as {
      code?: string;
      reason?: string;
      detail?: string;
      title?: string;
      issues?: { path: string; message: string }[];
    };
    throw new GatewayError(
      response.status,
      problem.code ?? "INTERNAL",
      problem.reason,
      problem.issues?.[0]?.message ??
        problem.detail ??
        problem.title ??
        "No se pudo completar la solicitud.",
      problem.issues ?? [],
    );
  }
  return payload as T;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
