import { createLogger } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createReadCache } from "../src/cache.js";
import {
  type EventDto,
  type EventSummaryDto,
  filterAndSort,
  summarize,
} from "../src/events/service.js";
import { SellableItemCatalog } from "../src/items/registry.js";
import { processImage } from "../src/media/service.js";
import { clpInput, slugify, uniqueSlug } from "../src/shared.js";
import { seatGrid } from "../src/venues/service.js";

const logger = createLogger({ service: "catalog-test", level: "silent" });

describe("slugs", () => {
  it("normaliza acentos y símbolos", () => {
    expect(slugify("  María de los Andes: ¡Función 2!  ")).toBe("maria-de-los-andes-funcion-2");
    expect(slugify("---")).toBe("");
  });

  it("agrega un sufijo aleatorio válido para la restricción de la BD", () => {
    const a = uniqueSlug("Lumen Tour");
    const b = uniqueSlug("Lumen Tour");
    expect(a).toMatch(/^lumen-tour-[a-z0-9]{5}$/);
    expect(a).not.toBe(b);
    expect(uniqueSlug("¡¡¡")).toMatch(/^item-[a-z0-9]{5}$/);
  });
});

describe("montos CLP de entrada", () => {
  it("acepta enteros no negativos y strings decimales", () => {
    expect(clpInput.parse(62000)).toBe(62000n);
    expect(clpInput.parse("145000")).toBe(145000n);
  });

  it("rechaza decimales, negativos y montos absurdos", () => {
    for (const value of [10.5, -1, "1e5", "12.00", 2_000_000_000]) {
      expect(clpInput.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe("grilla de butacas", () => {
  it("genera filas A, B… con butacas numeradas dentro del rectángulo", () => {
    const seats = seatGrid({ rows: 3, perRow: 4, x: 10, y: 20, w: 90, h: 40 });
    expect(seats).toHaveLength(12);
    expect(seats[0]).toEqual({ row: "A", number: 1, x: 10, y: 20 });
    expect(seats.at(-1)).toEqual({ row: "C", number: 4, x: 100, y: 60 });
  });

  it("después de la Z sigue con A1, B1…", () => {
    const rows = new Set(
      seatGrid({ rows: 28, perRow: 1, x: 0, y: 0, w: 10, h: 10 }).map((s) => s.row),
    );
    expect([...rows].slice(25)).toEqual(["Z", "A1", "B1"]);
  });
});

function event(overrides: Partial<EventDto> & Pick<EventDto, "id" | "title">): EventDto {
  return {
    slug: overrides.id,
    artist: null,
    category: "conciertos",
    description: null,
    imageId: null,
    imageUrl: null,
    status: "published",
    featured: false,
    urgencyNote: null,
    ageRestriction: null,
    ownerId: null,
    queue: {
      enabled: false,
      opensAt: null,
      concurrentSlots: 200,
      windowMinutes: 10,
      admitBatchMax: 50,
      waitingMessage: null,
    },
    dates: [],
    ...overrides,
  };
}

function date(startsAt: string, city: string, prices: string[]) {
  return {
    id: `${startsAt}-${city}`,
    startsAt,
    doorsAt: null,
    onSale: true,
    venue: { id: "v", name: `Recinto ${city}`, city },
    ticketTypes: prices.map((price, index) => ({
      id: `t${index}`,
      name: "Platea",
      price,
      fee: "0",
      capacity: 100,
      sectionId: `s${index}`,
      sectionKind: "general" as const,
      sortOrder: index,
    })),
  };
}

describe("resumen público de eventos", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");

  it("usa la próxima función, el precio mínimo y la capacidad total", () => {
    const summary = summarize(
      event({
        id: "a",
        title: "A",
        dates: [
          date("2026-10-01T00:00:00Z", "Talca", ["1000"]),
          date("2026-12-01T00:00:00Z", "Santiago", ["62000", "145000"]),
          date("2027-01-01T00:00:00Z", "Valparaíso", ["54000"]),
        ],
      }),
      now,
    );
    expect(summary).toMatchObject({
      nextDate: "2026-12-01T00:00:00Z",
      city: "Santiago",
      minPrice: "1000",
      capacity: 400,
      datesCount: 2,
    });
  });

  it("sin fechas: sin precio ni ciudad", () => {
    expect(summarize(event({ id: "b", title: "B" }), now)).toMatchObject({
      nextDate: null,
      minPrice: null,
      datesCount: 0,
    });
  });

  it("filtra por categoría, ciudad y texto (sin acentos) y ordena", () => {
    const events: EventSummaryDto[] = [
      summarize(
        event({
          id: "1",
          title: "Ópera",
          category: "teatro",
          dates: [date("2026-12-03T00:00:00Z", "Santiago", ["30000"])],
        }),
        now,
      ),
      summarize(
        event({
          id: "2",
          title: "Rock",
          featured: true,
          dates: [date("2026-12-02T00:00:00Z", "Santiago", ["90000"])],
        }),
        now,
      ),
      summarize(
        event({
          id: "3",
          title: "Jazz",
          dates: [date("2026-12-01T00:00:00Z", "Talca", ["10000"])],
        }),
        now,
      ),
    ];
    expect(filterAndSort(events, {}).map((e) => e.id)).toEqual(["3", "2", "1"]);
    expect(filterAndSort(events, { sort: "price" }).map((e) => e.id)).toEqual(["3", "1", "2"]);
    expect(filterAndSort(events, { sort: "popular" }).map((e) => e.id)[0]).toBe("2");
    expect(filterAndSort(events, { city: "Santiago" }).map((e) => e.id)).toEqual(["2", "1"]);
    expect(filterAndSort(events, { category: "teatro" }).map((e) => e.id)).toEqual(["1"]);
    expect(filterAndSort(events, { q: "opera" }).map((e) => e.id)).toEqual(["1"]);
  });
});

describe("procesamiento de imágenes", () => {
  it("re-codifica a WebP, reduce el tamaño y elimina los metadatos", async () => {
    const input = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#336699" },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "gps-secreto" } } })
      .toBuffer();
    const output = await processImage(input);
    expect(output.width).toBe(2400);
    expect(output.height).toBe(800);
    const meta = await sharp(output.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(output.data.includes("gps-secreto")).toBe(false);
  });

  it("rechaza archivos que no son imágenes aunque digan serlo", async () => {
    for (const fake of [
      Buffer.from("GIF89a<script>alert(1)</script>"),
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(0),
    ]) {
      await expect(processImage(fake)).rejects.toMatchObject({ reason: "INVALID_IMAGE" });
    }
  });

  it("rechaza formatos no soportados (SVG puede llevar scripts)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(processImage(svg)).rejects.toMatchObject({ reason: "INVALID_IMAGE" });
  });
});

describe("registro de ítems vendibles", () => {
  it("resuelve por tipo, sin duplicados, e ignora tipos no registrados", async () => {
    const resolve = vi.fn(async (_db: unknown, ids: string[]) =>
      ids.map((id) => ({
        id,
        kind: "gift_card",
        name: "Gift card",
        unitPrice: "10000",
        unitFee: "0",
        saleable: true,
        unsaleableReason: null,
        capacity: null,
        maxPerOrder: 5,
        requiresReservation: false,
        attributes: {},
      })),
    );
    // Un tipo nuevo se agrega sin tocar las rutas ni orders/payments (ASR05).
    const catalog = new SellableItemCatalog().register({ kind: "gift_card", resolve });
    const items = await catalog.resolve({ query: vi.fn() } as never, [
      { kind: "gift_card", id: "g1" },
      { kind: "gift_card", id: "g1" },
      { kind: "desconocido", id: "x" },
    ]);
    expect(items.map((item) => item.id)).toEqual(["g1"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(() => catalog.register({ kind: "gift_card", resolve })).toThrow();
  });
});

function fakeRedis(): Redis & { store: Map<string, string>; fail: boolean } {
  const store = new Map<string, string>();
  const redis = {
    store,
    fail: false,
    async get(key: string) {
      if (redis.fail) throw new Error("Connection is closed.");
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      if (redis.fail) throw new Error("Connection is closed.");
      store.set(key, value);
      return "OK";
    },
    async incr(key: string) {
      if (redis.fail) throw new Error("Connection is closed.");
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
  };
  return redis as unknown as Redis & { store: Map<string, string>; fail: boolean };
}

describe("caché de lectura", () => {
  it("sirve desde Redis y deja de hacerlo al invalidar (generación)", async () => {
    const redis = fakeRedis();
    const cache = createReadCache({ redis, ttlSeconds: 30, logger, prefix: "t:" });
    let version = 1;
    const load = vi.fn(async () => ({ version }));
    expect(await cache.get("k", load)).toEqual({ version: 1 });
    version = 2;
    expect(await cache.get("k", load)).toEqual({ version: 1 });
    await cache.invalidate();
    expect(await cache.get("k", load)).toEqual({ version: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("solicitudes simultáneas comparten una sola carga (sin estampida)", async () => {
    const cache = createReadCache({ redis: fakeRedis(), ttlSeconds: 30, logger, prefix: "t:" });
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [1, 2, 3];
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.get("lista", load)));
    expect(results.every((value) => value.length === 3)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("si Redis cae, lee de la BD sin fallar", async () => {
    const redis = fakeRedis();
    redis.fail = true;
    const cache = createReadCache({ redis, ttlSeconds: 30, logger, prefix: "t:" });
    expect(await cache.get("k", async () => "desde-bd")).toBe("desde-bd");
    await expect(cache.invalidate()).resolves.toBeUndefined();
  });

  it("los errores de la BD se propagan (no se cachean)", async () => {
    const cache = createReadCache({ redis: fakeRedis(), ttlSeconds: 30, logger, prefix: "t:" });
    await expect(
      cache.get("k", async () => {
        throw new Error("bd caída");
      }),
    ).rejects.toThrow("bd caída");
    expect(await cache.get("k", async () => "ok")).toBe("ok");
  });
});
