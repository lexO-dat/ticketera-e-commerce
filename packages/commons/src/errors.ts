/**
 * Errores de dominio con código estable. Se serializan como RFC 9457 (application/problem+json)
 * sin filtrar detalles internos: el mensaje de un error 5xx nunca llega al cliente.
 */

export const ErrorCode = {
  VALIDATION: "VALIDATION",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  // 422: misma clave con otra solicitud (docs/services/payments.md §6).
  IDEMPOTENCY_CONFLICT: 422,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const TITLE_BY_CODE: Record<ErrorCode, string> = {
  VALIDATION: "Solicitud inválida",
  UNAUTHENTICATED: "Autenticación requerida",
  FORBIDDEN: "Acceso denegado",
  NOT_FOUND: "Recurso no encontrado",
  CONFLICT: "Conflicto con el estado actual",
  IDEMPOTENCY_CONFLICT: "Clave de idempotencia reutilizada con otra solicitud",
  PRECONDITION_FAILED: "Precondición no cumplida",
  PAYLOAD_TOO_LARGE: "Solicitud demasiado grande",
  RATE_LIMITED: "Demasiadas solicitudes",
  DEPENDENCY_UNAVAILABLE: "Servicio no disponible temporalmente",
  INTERNAL: "Error interno",
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface FieldIssue {
  path: string;
  message: string;
}

export interface AppErrorOptions {
  /** Detalle seguro para mostrar al cliente. */
  detail?: string | undefined;
  /** Errores por campo (validación). */
  issues?: FieldIssue[] | undefined;
  /** Código de negocio más específico, p. ej. `SEAT_ALREADY_HELD`. */
  reason?: string | undefined;
  /** Segundos sugeridos antes de reintentar (429/503). */
  retryAfterSeconds?: number | undefined;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly issues: FieldIssue[] | undefined;
  readonly reason: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? TITLE_BY_CODE[code], { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = options.detail;
    this.issues = options.issues;
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Solo los errores 4xx exponen detalle al cliente. */
  get expose(): boolean {
    return this.status < 500;
  }

  static validation(issues: FieldIssue[], detail?: string): AppError {
    return new AppError(ErrorCode.VALIDATION, undefined, { issues, detail });
  }

  static notFound(detail?: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, undefined, { detail });
  }

  static conflict(reason: string, detail?: string): AppError {
    return new AppError(ErrorCode.CONFLICT, undefined, { reason, detail });
  }

  static unauthenticated(detail?: string): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, undefined, { detail });
  }

  static forbidden(detail?: string): AppError {
    return new AppError(ErrorCode.FORBIDDEN, undefined, { detail });
  }

  static unavailable(detail?: string, retryAfterSeconds?: number): AppError {
    return new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, undefined, { detail, retryAfterSeconds });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Cuerpo RFC 9457. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  reason?: string;
  issues?: FieldIssue[];
  requestId?: string;
}

export function toProblem(error: unknown, requestId?: string): Problem {
  const appError = isAppError(error) ? error : new AppError(ErrorCode.INTERNAL);
  const problem: Problem = {
    type: `urn:ticketera:error:${appError.code.toLowerCase()}`,
    title: TITLE_BY_CODE[appError.code],
    status: appError.status,
    code: appError.code,
  };
  if (appError.expose) {
    if (appError.detail) problem.detail = appError.detail;
    if (appError.reason) problem.reason = appError.reason;
    if (appError.issues?.length) problem.issues = appError.issues;
  }
  if (requestId) problem.requestId = requestId;
  return problem;
}
