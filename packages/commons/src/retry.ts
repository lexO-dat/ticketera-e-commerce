export interface RetryOptions {
  /** Intentos totales, incluido el primero. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decide si el error es transitorio. Por defecto reintenta todo. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Backoff exponencial con _full jitter_ (evita que todos los clientes reintenten a la vez). */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 100, maxDelayMs = 5_000, shouldRetry = () => true } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

export const CircuitState = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" } as const;
export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`Circuito abierto: ${circuit}`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Fallos consecutivos que abren el circuito. */
  failureThreshold?: number;
  /** Tiempo abierto antes de dejar pasar una solicitud de prueba. */
  resetTimeoutMs?: number;
  now?: () => number;
}

/** _Circuit breaker_ para llamadas entre servicios: falla rápido mientras la dependencia está caída. */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    if (this.state === CircuitState.OPEN && this.now() - this.openedAt >= this.resetTimeoutMs) {
      return CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === CircuitState.OPEN) throw new CircuitOpenError(this.options.name);
    if (state === CircuitState.HALF_OPEN) {
      if (this.probeInFlight) throw new CircuitOpenError(this.options.name);
      this.probeInFlight = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = CircuitState.CLOSED;
      return result;
    } catch (error) {
      this.failures++;
      if (state === CircuitState.HALF_OPEN || this.failures >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (state === CircuitState.HALF_OPEN) this.probeInFlight = false;
    }
  }
}
