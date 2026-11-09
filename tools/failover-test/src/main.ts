/**
 * Prueba de failover (ASR01): sondas continuas contra el borde (Nginx → gateway → servicios)
 * mientras se bota un componente con `docker kill`. Mide la ventana de indisponibilidad de cada
 * sonda (primer error → última respuesta fallida) y comprueba que la sesión y el carro sobreviven.
 *
 *   npm run failover -- --scenario service:catalog
 *   npm run failover -- --scenario all
 */
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    edge: { type: "string", default: "https://localhost:8443/api" },
    "budget-seconds": { type: "string", default: "5" },
    "observe-seconds": { type: "string", default: "25" },
    compose: { type: "string", default: "infra/docker-compose.yml" },
    gateway: { type: "string", default: "http://127.0.0.1:3000" },
  },
});

// Certificado autofirmado del Nginx de desarrollo.
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
process.removeAllListeners("warning");

const EDGE = args.edge!;
/** npm ejecuta la herramienta desde su carpeta: docker y npm corren desde la raíz del repo. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUDGET_MS = Number(args["budget-seconds"]) * 1000;
const SLOW_MS = 1000;
const OBSERVE_MS = Number(args["observe-seconds"]) * 1000;
const PROJECT = "ticketera";
const print = (line: string) =>
  process.stdout.write(`${line}
`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Componentes que se pueden botar y cómo reconocer su contenedor. */
const SCENARIOS: Record<string, { container: string; description: string }> = {
  "service:catalog": { container: `${PROJECT}-catalog-1`, description: "una réplica de catalog" },
  "service:identity": {
    container: `${PROJECT}-identity-1`,
    description: "una réplica de identity",
  },
  "service:orders": { container: `${PROJECT}-orders-1`, description: "una réplica de orders" },
  gateway: { container: `${PROJECT}-gateway-1`, description: "una réplica del gateway" },
  web: { container: `${PROJECT}-web-1`, description: "una réplica de la web (SSR)" },
  redis: { container: "<redis:primary>", description: "Redis primario" },
  // Tras un failover los roles se invierten: se resuelve en el momento cuál nodo es cuál.
  postgres: { container: "<pg:primary>", description: "PostgreSQL primaria" },
  "postgres-standby": { container: "<pg:standby>", description: "la réplica de PostgreSQL" },
};

interface Sample {
  at: number;
  /** Cuándo llegó la respuesta: una solicitud colgada también es indisponibilidad. */
  end: number;
  ok: boolean;
  status: number;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const response = await fetch(EDGE + path, {
      method,
      headers: {
        accept: "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  } catch {
    return { status: 0, body: {} };
  }
}

interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Cuentas de prueba: se registran una sola vez y se guardan en `.data/` (el registro tiene un
 * límite estricto por IP y todas las sondas salen por Nginx desde la misma IP).
 */
async function accounts(): Promise<{ email: string; password: string }[]> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".data", "accounts.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { email: string; password: string }[];
  } catch {
    const created = ["cart", "session"].map((label) => ({
      email: `failover-${label}-${randomUUID().slice(0, 8)}@acceptme.com`,
      password: randomUUID(),
    }));
    for (const account of created) {
      // Directo al gateway (red de confianza) con una IP propia, como el simulador de carga.
      const registered = await fetch(`${args.gateway}/auth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `10.99.0.${1 + randomInt(250)}`,
        },
        body: JSON.stringify({ ...account, fullName: "Prueba Failover" }),
      });
      if (registered.status !== 202) throw new Error(`registro ${registered.status}`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(created));
    return created;
  }
}

async function login(account: { email: string; password: string }): Promise<Session> {
  const response = await call("POST", "/auth/login", { body: account });
  if (response.status !== 200) {
    throw new Error(`login ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return {
    email: account.email,
    accessToken: String(response.body["accessToken"]),
    refreshToken: String(response.body["refreshToken"]),
  };
}

/** Una sonda: repite `run` cada `everyMs` y anota si respondió bien. */
function probe(name: string, everyMs: number, run: () => Promise<boolean | number>) {
  const samples: Sample[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      const result = await run().catch(() => 0);
      const ok = result === true;
      samples.push({
        at: started,
        end: Date.now(),
        ok,
        status: typeof result === "number" ? result : ok ? 200 : 0,
      });
      await sleep(Math.max(0, everyMs - (Date.now() - started)));
    }
  })();
  return {
    name,
    samples,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

function compose(...rest: string[]): void {
  execFileSync("docker", ["compose", "-f", args.compose!, ...rest], { stdio: "ignore", cwd: ROOT });
}

/** Nodo de PostgreSQL que hoy acepta escrituras (o el que no, para `<pg:standby>`). */
function resolveContainer(container: string): string {
  if (container === "<redis:primary>") {
    // Sentinel sabe cuál es el primario; las IP fijas de docker-compose.yml dicen qué contenedor.
    const out = execFileSync(
      "docker",
      [
        "compose",
        "-f",
        args.compose!,
        "exec",
        "-T",
        "redis-sentinel-1",
        "redis-cli",
        "-p",
        "26379",
        "sentinel",
        "get-master-addr-by-name",
        "ticketera",
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    const ip = out.trim().split(/\s+/)[0];
    const byIp: Record<string, string> = {
      "172.28.0.10": "redis-primary",
      "172.28.0.11": "redis-replica",
    };
    if (!ip || !byIp[ip]) throw new Error(`primario de Redis desconocido: ${out}`);
    return `${PROJECT}-${byIp[ip]}-1`;
  }
  if (!container.startsWith("<pg:")) return container;
  const nodes = ["postgres-primary", "postgres-replica"];
  const primary = nodes.find((node) => {
    try {
      const out = execFileSync(
        "docker",
        [
          "compose",
          "-f",
          args.compose!,
          "exec",
          "-T",
          node,
          "psql",
          "-U",
          "postgres",
          "-tAc",
          "select (not pg_is_in_recovery() and current_setting('default_transaction_read_only') = 'off')::text",
        ],
        { encoding: "utf8", cwd: ROOT },
      );
      return out.trim() === "true";
    } catch {
      return false;
    }
  });
  if (!primary) throw new Error("no hay primaria de PostgreSQL");
  const node = container === "<pg:primary>" ? primary : nodes.find((n) => n !== primary)!;
  return `${PROJECT}-${node}-1`;
}

async function runScenario(key: string, cartUser: Session, sessionUser: Session): Promise<boolean> {
  const definition = SCENARIOS[key];
  if (!definition) throw new Error(`escenario desconocido: ${key}`);
  const scenario = { ...definition, container: resolveContainer(definition.container) };
  print(`\n▶ ${key}: se bota ${scenario.description} (${scenario.container})`);

  const products = await call("GET", "/catalog/products");
  const product = (products.body["items"] as { id: string; name: string }[] | undefined)?.[0];
  if (!product) throw new Error("no hay productos en el catálogo");
  const itemKey = `product:${product.id}`;
  const added = await call("POST", "/orders/cart/items", {
    token: cartUser.accessToken,
    body: {
      items: [
        {
          key: itemKey,
          kind: "product",
          itemId: product.id,
          quantity: 1,
          unitPrice: 0,
          unitFee: 0,
        },
      ],
    },
  });
  if (added.status !== 200) throw new Error(`carro ${added.status}`);

  const ok = (status: number) => (status >= 200 && status < 300 ? true : status);
  const probes = [
    probe("web: página de la tienda (SSR)", 250, async () => {
      // La raíz del borde (sin /api): Nginx → contenedores web → gateway.
      const page = await fetch(new URL("/tienda", EDGE), { signal: AbortSignal.timeout(8000) })
        .then((response) => response.status)
        .catch(() => 0);
      return ok(page);
    }),
    probe("catálogo (lectura pública)", 250, async () =>
      ok((await call("GET", "/catalog/events")).status),
    ),
    probe("carro (Redis, con sesión)", 250, async () => {
      const cart = await call("GET", "/orders/cart", { token: cartUser.accessToken });
      if (cart.status !== 200) return cart.status;
      // El carro debe seguir ahí: perderlo también cuenta como falla.
      const items = cart.body["items"] as { key: string }[];
      return items.some((item) => item.key === itemKey) ? true : 409;
    }),
    probe("mis órdenes (PostgreSQL, lectura)", 250, async () =>
      ok((await call("GET", "/orders/orders", { token: sessionUser.accessToken })).status),
    ),
    probe("renovar sesión (PostgreSQL, escritura)", 2000, async () => {
      const refreshed = await call("POST", "/auth/refresh", {
        body: { refreshToken: sessionUser.refreshToken },
      });
      if (refreshed.status !== 200) return refreshed.status;
      sessionUser.accessToken = String(refreshed.body["accessToken"]);
      sessionUser.refreshToken = String(refreshed.body["refreshToken"]);
      return true;
    }),
  ];

  await sleep(3000);
  const killedAt = Date.now();
  execFileSync("docker", ["kill", scenario.container], { stdio: "ignore" });
  await sleep(OBSERVE_MS);
  await Promise.all(probes.map((p) => p.stop()));

  let passed = true;
  for (const p of probes) {
    const before = p.samples.filter((s) => s.at < killedAt);
    const after = p.samples.filter((s) => s.at >= killedAt);
    const failures = after.filter((s) => !s.ok);
    // Ventana = desde que empezó la primera solicitud fallida o lenta (> 1 s) hasta que terminó la
    // última: mide lo que el usuario percibe, incluidas las esperas.
    const degraded = after.filter((s) => !s.ok || s.end - s.at > SLOW_MS);
    const window = degraded.length === 0 ? 0 : degraded.at(-1)!.end - degraded[0]!.at;
    const slowest = Math.max(0, ...after.map((s) => s.end - s.at));
    const recovered = after.slice(-5).every((s) => s.ok);
    const statuses = [...new Set(failures.map((s) => s.status))].join(",");
    const good = before.every((s) => s.ok) && recovered && window <= BUDGET_MS;
    passed &&= good;
    print(
      `  ${good ? "✓" : "✗"} ${p.name.padEnd(38)} ventana ${(window / 1000).toFixed(1)} s · ` +
        `${failures.length}/${after.length} fallidas${statuses ? ` (${statuses})` : ""} · ` +
        `máx. ${(slowest / 1000).toFixed(1)} s` +
        `${recovered ? "" : " · NO se recuperó"}`,
    );
  }

  // Restaurar: el contenedor botado vuelve (en Postgres, como réplica de la nueva primaria).
  if (key === "postgres") {
    execFileSync("npm", ["run", "infra:pg-rejoin", "--silent"], {
      stdio: "inherit",
      shell: true,
      cwd: ROOT,
    });
  } else {
    // `--wait` puede fallar si un healthcheck aún no responde: un segundo intento basta.
    try {
      compose("up", "-d", "--wait");
    } catch {
      await sleep(5000);
      compose("up", "-d", "--wait");
    }
  }
  return passed;
}

async function main(): Promise<void> {
  const keys = args.scenario === "all" ? Object.keys(SCENARIOS) : args.scenario!.split(",");
  const results: [string, boolean][] = [];
  const [cartAccount, sessionAccount] = await accounts();
  const cartUser = await login(cartAccount!);
  const sessionUser = await login(sessionAccount!);
  for (const key of keys) results.push([key, await runScenario(key, cartUser, sessionUser)]);
  print(`\nResumen (presupuesto ≤ ${BUDGET_MS / 1000} s):`);
  for (const [key, ok] of results) print(`  ${ok ? "✓" : "✗"} ${key}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
