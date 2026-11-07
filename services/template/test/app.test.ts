import { AppError, createLogger } from "@shared/commons";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { NotesService } from "../src/notes/service.js";

const logger = createLogger({ service: "template-test", level: "silent" });
const NOTE = {
  id: "6f1c1a52-8a39-4f7c-9a55-3f2f0c1d2e3f",
  text: "hola",
  createdAt: new Date("2026-11-07T12:00:00Z"),
};

const fakeNotes: NotesService = {
  create: async (text) => ({ ...NOTE, text }),
  get: async (id) => {
    if (id !== NOTE.id) throw AppError.notFound("La nota no existe");
    return NOTE;
  },
};

describe("template (unitario)", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("expone info y health", async () => {
    app = buildApp({ serviceName: "template", logger, notes: fakeNotes });
    expect((await app.inject({ url: "/v1/info" })).json()).toEqual({
      service: "template",
      version: "0.1.0",
    });
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
  });

  it("valida el cuerpo en el borde", async () => {
    app = buildApp({ serviceName: "template", logger, notes: fakeNotes });
    const empty = await app.inject({ method: "POST", url: "/v1/notes", payload: { text: "   " } });
    expect(empty.statusCode).toBe(400);
    const extra = await app.inject({
      method: "POST",
      url: "/v1/notes",
      payload: { text: "ok", admin: true },
    });
    expect(extra.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/v1/notes",
      payload: { text: "  ok  " },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().text).toBe("ok");
  });

  it("responde 404 problem+json y 400 con id inválido", async () => {
    app = buildApp({ serviceName: "template", logger, notes: fakeNotes });
    expect((await app.inject({ url: `/v1/notes/${NOTE.id}` })).statusCode).toBe(200);
    const missing = await app.inject({ url: "/v1/notes/00000000-0000-4000-8000-000000000000" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect((await app.inject({ url: "/v1/notes/no-uuid" })).statusCode).toBe(400);
  });
});
