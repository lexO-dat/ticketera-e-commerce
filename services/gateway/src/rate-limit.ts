import { AppError, type Logger, sha256Hex } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitRule {
  name: string;
  /** Solicitudes permitidas por ventana. */
  limit: number;
  windowSeconds: number;
  /** Por IP (anónimo / anti fuerza bruta) o por usuario autenticado (cae a IP si no hay sesión). */
  by: "ip" | "user";
  matches(method: string, path: string): boolean;
}

// Ventana fija atómica: INCR + PEXPIRE la primera vez. Devuelve {cuenta, ms restantes}.
const WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
return {count, ttl}`;

export function defaultRules(perMinute: number): RateLimitRule[] {
  const post = (path: string) => (method: string, url: string) => method === "POST" && url === path;
  return [
    // Fuerza bruta y abuso de cuentas: límites estrictos por IP (identity además bloquea la cuenta).
    { name: "login", limit: 10, windowSeconds: 60, by: "ip", matches: post("/auth/login") },
    { name: "register", limit: 5, windowSeconds: 600, by: "ip", matches: post("/auth/register") },
    {
      name: "forgot",
      limit: 5,
      windowSeconds: 600,
      by: "ip",
      matches: post("/auth/password/forgot"),
    },
    {
      name: "reset",
      limit: 10,
      windowSeconds: 600,
      by: "ip",
      matches: post("/auth/password/reset"),
    },
    { name: "refresh", limit: 60, windowSeconds: 60, by: "ip", matches: post("/auth/refresh") },
    // Fila y reservas: un turno por usuario ya es idempotente; esto frena el abuso de bots.
    {
      name: "queue-join",
      limit: 10,
      windowSeconds: 60,
      by: "user",
      matches: (method, url) => method === "POST" && /^\/queue\/events\/[^/]+\/join$/.test(url),
    },
    {
      name: "reserve",
      limit: 30,
      windowSeconds: 60,
      by: "user",
      matches: (method, url) => method === "POST" && url === "/inventory/reservations",
    },
    // Antifraude: pocos checkouts por usuario (cada uno abre un cobro).
    {
      name: "checkout",
      limit: 10,
      windowSeconds: 60,
      by: "user",
      matches: (method, url) =>
        method === "POST" && (url === "/orders/checkout" || url.endsWith("/pay")),
    },
    // Endpoints públicos de catalog (embudo y newsletter): baratos, pero no deben inflarse con bots.
    {
      name: "event-views",
      limit: 60,
      windowSeconds: 60,
      by: "ip",
      matches: (method, url) => method === "POST" && /^\/catalog\/events\/[^/]+\/views$/.test(url),
    },
    {
      name: "newsletter",
      limit: 5,
      windowSeconds: 600,
      by: "ip",
      matches: post("/catalog/newsletter"),
    },
    { name: "global", limit: perMinute, windowSeconds: 60, by: "user", matches: () => true },
  ];
}

/**
 * Rate limiting distribuido (Redis compartido por todas las réplicas del gateway). Aplica todas las
 * reglas que coinciden; si Redis no responde, deja pasar y registra (prefiere disponibilidad: identity
 * conserva su bloqueo por cuenta).
 */
export function createRateLimiter(redis: Redis, rules: RateLimitRule[], logger: Logger) {
  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split("?")[0] ?? "/";
    if (path.startsWith("/health/")) return;
    for (const rule of rules) {
      if (!rule.matches(request.method, path)) continue;
      const subject =
        rule.by === "user" && request.user ? `u:${request.user.id}` : `ip:${request.ip}`;
      const key = `rl:${rule.name}:${sha256Hex(subject).slice(0, 32)}`;
      let count: number;
      let ttlMs: number;
      try {
        const result = (await redis.eval(WINDOW_SCRIPT, 1, key, rule.windowSeconds * 1000)) as [
          number,
          number,
        ];
        [count, ttlMs] = result;
      } catch (error) {
        logger.warn(
          { err: error, rule: rule.name },
          "rate limit: Redis no disponible, se permite la solicitud",
        );
        return;
      }
      const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      if (rule.name === "global") {
        reply.header("ratelimit-limit", rule.limit);
        reply.header("ratelimit-remaining", Math.max(0, rule.limit - count));
        reply.header("ratelimit-reset", resetSeconds);
      }
      if (count > rule.limit) {
        throw new AppError("RATE_LIMITED", undefined, {
          reason: `RATE_LIMIT_${rule.name.toUpperCase()}`,
          detail: "Demasiadas solicitudes; espera un momento y vuelve a intentar",
          retryAfterSeconds: resetSeconds,
        });
      }
    }
  };
}
