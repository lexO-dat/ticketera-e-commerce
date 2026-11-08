import type { Redis } from "@shared/commons/redis";

/** Transacción tal como la guarda el mock (Redis, con TTL). */
export interface MockTransaction {
  token: string;
  buyOrder: string;
  sessionId: string;
  amount: number;
  returnUrl: string;
  payerEmail: string | null;
  status:
    "INITIALIZED" | "AUTHORIZED" | "FAILED" | "REVERSED" | "NULLIFIED" | "PARTIALLY_NULLIFIED";
  /** El comprador apretó "Pagar" en el formulario. */
  submitted: boolean;
  /** El comprador anuló en el formulario. */
  aborted: boolean;
  committed: boolean;
  responseCode: number | null;
  authorizationCode: string | null;
  mockReason: string | null;
  balance: number;
  createdAt: string;
  committedAt: string | null;
}

const key = (token: string) => `wpm:tx:${token}`;

/**
 * Cambio atómico de una transacción: aplica `patch` solo si el campo `guard` tiene el valor
 * esperado (evita, p. ej., dos commits concurrentes sobre el mismo token).
 */
const UPDATE_IF = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local tx = cjson.decode(raw)
local current = tx[ARGV[1]]
if tostring(current) ~= ARGV[2] then return 0 end
local patch = cjson.decode(ARGV[3])
for k, v in pairs(patch) do tx[k] = v end
local encoded = cjson.encode(tx)
redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
return encoded
`;

export function createStore(redis: Redis, ttlSeconds: number) {
  return {
    async create(tx: MockTransaction): Promise<void> {
      await redis.set(key(tx.token), JSON.stringify(tx), "EX", ttlSeconds);
    },
    async get(token: string): Promise<MockTransaction | undefined> {
      const raw = await redis.get(key(token));
      return raw ? (JSON.parse(raw) as MockTransaction) : undefined;
    },
    /** `undefined` si no existe; `null` si la guarda no se cumplió. */
    async updateIf(
      token: string,
      guard: { field: keyof MockTransaction; equals: string },
      patch: Partial<MockTransaction>,
    ): Promise<MockTransaction | null | undefined> {
      const result = (await redis.eval(
        UPDATE_IF,
        1,
        key(token),
        guard.field,
        guard.equals,
        JSON.stringify(patch),
      )) as string | null | 0;
      if (result === null) return undefined;
      if (result === 0) return null;
      return JSON.parse(result) as MockTransaction;
    },
  };
}

export type MockStore = ReturnType<typeof createStore>;
