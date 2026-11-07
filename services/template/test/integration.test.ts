/** Integración contra Postgres real. Se activa con TEST_DATABASE_URL (ver README). */
import { fileURLToPath } from "node:url";
import { createLogger, newId } from "@shared/commons";
import { createPool, runMigrations, type Pool } from "@shared/commons/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createNotesService } from "../src/notes/service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const logger = createLogger({ service: "template-test", level: "silent" });

describe.skipIf(!DATABASE_URL)("template (integración)", () => {
  let pool: Pool;
  const schema = `template_${newId().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "template-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ connectionString: url.toString(), applicationName: "template-test" });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("crea la nota y su evento en la misma transacción", async () => {
    const app = buildApp({ serviceName: "template", logger, notes: createNotesService(pool) });
    const created = await app.inject({
      method: "POST",
      url: "/v1/notes",
      payload: { text: "primera" },
      headers: { "x-request-id": "req-12345678" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const fetched = await app.inject({ url: `/v1/notes/${id}` });
    expect(fetched.json().text).toBe("primera");

    const { rows } = await pool.query("select type, aggregate_id, payload from outbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "NotaCreada", aggregate_id: id });
    expect(rows[0].payload.correlationId).toBe("req-12345678");
    await app.close();
  });
});
