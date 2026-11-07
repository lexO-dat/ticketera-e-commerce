import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DomainEvents, HttpServices, bindingFor, routingKey } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("OpenAPI", () => {
  it("todos los documentos son OpenAPI 3.1 válidos y sus $ref resuelven", async () => {
    const files = (await readdir(join(root, "openapi"))).filter((file) => file.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const api = await SwaggerParser.validate(join(root, "openapi", file));
      expect(api, file).toHaveProperty("openapi", "3.1.0");
    }
  });

  it("cada servicio HTTP declarado tiene contrato con health checks", async () => {
    for (const service of HttpServices) {
      const api = (await SwaggerParser.dereference(join(root, "openapi", `${service}.yaml`))) as {
        paths: Record<string, unknown>;
      };
      expect(Object.keys(api.paths)).toEqual(
        expect.arrayContaining(["/health/live", "/health/ready"]),
      );
    }
  });
});

describe("AsyncAPI", () => {
  it("el catálogo de eventos y el documento AsyncAPI coinciden", async () => {
    const doc = parse(await readFile(join(root, "asyncapi", "events.yaml"), "utf8")) as {
      asyncapi: string;
      channels: Record<string, { address: string; messages: Record<string, unknown> }>;
      components: { messages: Record<string, unknown> };
      operations: Record<string, { channel: { $ref: string } }>;
    };
    expect(doc.asyncapi).toMatch(/^3\./);
    const types = Object.keys(DomainEvents).sort();
    expect(Object.keys(doc.channels).sort()).toEqual(types);
    expect(Object.keys(doc.components.messages).sort()).toEqual(types);
    for (const type of types) {
      const typed = type as keyof typeof DomainEvents;
      expect(doc.channels[type]?.address, type).toBe(routingKey(typed));
      expect(doc.operations[`publish${type}`]?.channel.$ref).toBe(`#/channels/${type}`);
    }
  });

  it("genera claves de enrutamiento y patrones de suscripción", () => {
    expect(routingKey("OrdenConfirmada")).toBe("orders.OrdenConfirmada.v1");
    expect(bindingFor("PagoAutorizado")).toBe("payments.PagoAutorizado.*");
  });
});
