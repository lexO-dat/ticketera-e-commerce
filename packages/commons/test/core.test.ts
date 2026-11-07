import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
  ConfigError,
  ErrorCode,
  SellableItemRegistry,
  addClp,
  baseServiceEnv,
  clp,
  createEvent,
  loadConfig,
  multiplyClp,
  nonNegativeClp,
  parseEvent,
  percentOfClp,
  retry,
  routingKeyFor,
  safeEqual,
  secureCode,
  toProblem,
} from "../src/index.js";

describe("money (CLP en bigint)", () => {
  it("rechaza decimales y valores no enteros", () => {
    expect(() => clp(10.5)).toThrow(RangeError);
    expect(() => clp("10.5")).toThrow(RangeError);
    expect(() => clp(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => nonNegativeClp(-1)).toThrow(RangeError);
  });

  it("suma y multiplica sin perder precisión", () => {
    const total = addClp(multiplyClp(clp(35_000), 2), clp("7000"));
    expect(total).toBe(77_000n);
    expect(multiplyClp(clp("9007199254740993"), 3)).toBe(27021597764222979n);
  });

  it("calcula porcentajes en puntos básicos con redondeo half-up", () => {
    expect(percentOfClp(clp(10_000), 1_000)).toBe(1_000n); // 10 %
    expect(percentOfClp(clp(15), 1_000)).toBe(2n); // 1,5 → 2
    expect(percentOfClp(clp(14), 1_000)).toBe(1n); // 1,4 → 1
    expect(percentOfClp(clp(-15), 1_000)).toBe(-2n);
  });
});

describe("ids", () => {
  it("genera códigos con el alfabeto de Crockford y prefijo", () => {
    const code = secureCode(10, "TK");
    expect(code).toMatch(/^TK-[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it("no repite códigos en una muestra grande", () => {
    const codes = new Set(Array.from({ length: 10_000 }, () => secureCode(12)));
    expect(codes.size).toBe(10_000);
  });

  it("compara en tiempo constante", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("errores (RFC 9457)", () => {
  it("expone el detalle de errores 4xx", () => {
    const problem = toProblem(
      AppError.conflict("SEAT_ALREADY_HELD", "La butaca ya está reservada"),
      "req-1",
    );
    expect(problem).toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      reason: "SEAT_ALREADY_HELD",
      detail: "La butaca ya está reservada",
      requestId: "req-1",
    });
  });

  it("oculta el detalle de errores internos y de errores desconocidos", () => {
    const internal = toProblem(
      new AppError(ErrorCode.INTERNAL, "password=hunter2", { detail: "secreto" }),
    );
    expect(internal.detail).toBeUndefined();
    expect(JSON.stringify(internal)).not.toContain("hunter2");
    const unknown = toProblem(new Error("SQL: select * from users"));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown)).not.toContain("select");
  });
});

describe("config", () => {
  const schema = baseServiceEnv.extend({ DATABASE_URL: z.url() });

  it("aplica valores por defecto y convierte tipos", () => {
    const config = loadConfig(schema, {
      SERVICE_NAME: "x",
      PORT: "4000",
      DATABASE_URL: "postgres://h/db",
    });
    expect(config.PORT).toBe(4000);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("falla sin mostrar los valores", () => {
    expect(() => loadConfig(schema, { SERVICE_NAME: "x", DATABASE_URL: "s3cr3t-no-url" })).toThrow(
      ConfigError,
    );
    try {
      loadConfig(schema, { SERVICE_NAME: "x", DATABASE_URL: "s3cr3t-no-url" });
    } catch (error) {
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).not.toContain("s3cr3t");
    }
  });
});

describe("retry y circuit breaker", () => {
  it("reintenta hasta tener éxito", async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transitorio");
        return "ok";
      },
      { attempts: 5, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("no reintenta errores permanentes", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw AppError.validation([]);
        },
        { attempts: 5, baseDelayMs: 1, shouldRetry: (error) => !(error instanceof AppError) },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toBe(1);
  });

  it("abre el circuito tras N fallos y deja pasar una prueba tras el timeout", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      name: "x",
      failureThreshold: 2,
      resetTimeoutMs: 100,
      now: () => now,
    });
    const fail = () => Promise.reject(new Error("caído"));
    await expect(breaker.execute(fail)).rejects.toThrow("caído");
    await expect(breaker.execute(fail)).rejects.toThrow("caído");
    expect(breaker.currentState).toBe(CircuitState.OPEN);
    await expect(breaker.execute(() => Promise.resolve(1))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    now = 150;
    expect(breaker.currentState).toBe(CircuitState.HALF_OPEN);
    await expect(breaker.execute(() => Promise.resolve(1))).resolves.toBe(1);
    expect(breaker.currentState).toBe(CircuitState.CLOSED);
  });
});

describe("eventos", () => {
  it("crea un sobre válido y su clave de enrutamiento", () => {
    const event = createEvent({
      type: "OrdenConfirmada",
      source: "orders",
      aggregateId: "ord-1",
      data: { orderId: "ord-1", total: "77000" },
    });
    expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(routingKeyFor(event)).toBe("orders.OrdenConfirmada.v1");
  });

  it("rechaza sobres inválidos", () => {
    expect(() => parseEvent({ id: "x", type: "orden_confirmada" })).toThrow();
  });
});

describe("ItemVendible", () => {
  it("permite registrar tipos nuevos sin tocar el consumidor", async () => {
    const registry = new SellableItemRegistry<{ id: string; price: number }>();
    registry.register("gift_card", (source) => ({
      id: source.id,
      kind: "gift_card",
      name: "Gift card",
      price: () => clp(source.price),
      fee: () => clp(0),
      availability: async () => Number.POSITIVE_INFINITY,
      reserve: async () => {
        throw new Error("no aplica");
      },
    }));
    const item = registry.create("gift_card", { id: "g1", price: 20_000 });
    expect(item.price()).toBe(20_000n);
    expect(() => registry.create("desconocido", { id: "x", price: 1 })).toThrow();
    expect(() => registry.register("gift_card", () => item)).toThrow();
  });
});
