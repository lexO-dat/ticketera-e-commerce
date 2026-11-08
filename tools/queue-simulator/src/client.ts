/**
 * Cliente HTTP del gateway para los bots. Cada bot se presenta con su propia IP
 * (`X-Forwarded-For`): el gateway la acepta porque el simulador corre en una red de confianza, y
 * así los límites por IP se aplican por bot, como con clientes reales.
 */
export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
  ms: number;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly ip: string,
  ) {}

  accessToken: string | undefined;

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      redirect?: "follow" | "manual";
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-forwarded-for": this.ip,
      ...options.headers,
    };
    if (this.accessToken) headers["authorization"] = `Bearer ${this.accessToken}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const started = performance.now();
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(30_000),
        ...(options.redirect ? { redirect: options.redirect } : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : {}) as T,
        headers: response.headers,
        ms: performance.now() - started,
      };
    } catch (error) {
      return {
        status: 0,
        body: { error: error instanceof Error ? error.message : String(error) } as T,
        headers: new Headers(),
        ms: performance.now() - started,
      };
    }
  }
}

/** IP privada estable por bot (10.x.y.z). */
export function botIp(index: number): string {
  return `10.${(Math.floor(index / 64516) % 254) + 1}.${(Math.floor(index / 254) % 254) + 1}.${(index % 254) + 1}`;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
