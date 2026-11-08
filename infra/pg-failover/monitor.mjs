// Monitor de failover de PostgreSQL (ADR-01). Sondea los nodos cada segundo y:
//  1. Si la primaria no responde FAILURE_THRESHOLD veces seguidas y hay una réplica sana, la
//     promueve (`pg_promote`) y la deja sin standby síncrono (si no, las escrituras esperarían
//     para siempre a una réplica que no existe).
//  2. Aísla a cualquier otro nodo que acepte escrituras (la primaria vieja que reaparece):
//     `default_transaction_read_only = on` y corta sus conexiones. Los servicios (pool de commons)
//     descartan nodos de solo lectura, así que nunca escriben en él (sin split brain).
//  3. Si la réplica cae, degrada la primaria a replicación asíncrona para no bloquear las
//     escrituras, y la vuelve a síncrona cuando hay un standby transmitiendo.
// La primaria vieja vuelve como réplica con `npm run infra:pg-rejoin` (clon desde la nueva).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

// `nombre=ip:puerto`. Por IP: resolver el nombre de un contenedor caído tarda ~5 s y, con varias
// consultas colgadas, satura el pool de hilos de Node y atrasa también las del nodo sano.
const NODES = (process.env.NODES ?? "postgres-primary:5432,postgres-replica:5432")
  .split(",")
  .map((entry) => {
    const [name, address] = entry.trim().includes("=")
      ? entry.trim().split("=")
      : [entry.trim(), entry.trim()];
    const [host, port] = address.split(":");
    return { name, host, port: Number(port || 5432) };
  });
const INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? 500);
/** Fallas seguidas para promover si la réplica aún recibe WAL (la primaria podría estar ocupada). */
const FAILURE_THRESHOLD = Number(process.env.FAILURE_THRESHOLD ?? 3);
const SYNC_NAMES = process.env.SYNC_STANDBY_NAMES ?? "ANY 1 (replica1)";
const STATE_FILE = process.env.STATE_FILE ?? "/state/leader.json";
const credentials = {
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD,
  database: "postgres",
};

const log = (level, msg, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), service: "pg-failover", msg, ...extra })}\n`,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadLeader() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).leader;
  } catch {
    return undefined;
  }
}

function saveLeader(leader) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ leader, since: new Date().toISOString() }));
}

/** Ejecuta `sql` en un nodo con timeouts cortos (un nodo colgado cuenta como caído). */
async function run(node, sql) {
  const client = new pg.Client({
    ...credentials,
    host: node.host,
    port: node.port,
    // Holgura para la avalancha de reconexiones de los servicios justo después de un failover: un
    // nodo ocupado no debe contar como caído (un nodo apagado falla al instante igual).
    connectionTimeoutMillis: Number(process.env.CONNECT_TIMEOUT_MS ?? 1000),
    query_timeout: 2000,
    application_name: "pg-failover",
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return (await client.query(sql)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probe(node) {
  try {
    const [row] = await run(
      node,
      `select pg_is_in_recovery() as standby,
              current_setting('default_transaction_read_only') = 'on' as fenced,
              current_setting('synchronous_standby_names') as sync_names,
              (select count(*)::int from pg_stat_replication where state = 'streaming') as streaming,
              coalesce((select status from pg_stat_wal_receiver), 'none') as receiver`,
    );
    return { up: true, ...row };
  } catch (error) {
    return { up: false, error: error.message };
  }
}

async function setSyncNames(node, value) {
  await run(node, `alter system set synchronous_standby_names = '${value.replaceAll("'", "''")}'`);
  await run(node, "select pg_reload_conf()");
  log("info", value ? "replicación síncrona activada" : "sin standby: replicación asíncrona", {
    node: node.name,
    synchronous_standby_names: value,
  });
}

async function fence(node) {
  await run(node, "alter system set default_transaction_read_only = on");
  await run(node, "select pg_reload_conf()");
  await run(
    node,
    `select pg_terminate_backend(pid) from pg_stat_activity
      where backend_type = 'client backend' and pid <> pg_backend_pid()
        and application_name <> 'pg-failover'`,
  );
  log("warn", "nodo aislado: aceptaba escrituras sin ser la primaria", { node: node.name });
}

async function main() {
  let leader = loadLeader();
  let leaderFailures = 0;
  let withoutStandby = 0;
  log("info", "monitor iniciado", { nodes: NODES.map((n) => n.name), leader });

  for (;;) {
    const started = Date.now();
    const status = new Map(await Promise.all(NODES.map(async (n) => [n.name, await probe(n)])));
    const byName = (name) => NODES.find((n) => n.name === name);

    if (!leader) {
      const writable = NODES.filter((n) => {
        const s = status.get(n.name);
        return s.up && !s.standby && !s.fenced;
      });
      if (writable.length === 1) {
        leader = writable[0].name;
        saveLeader(leader);
        log("info", "primaria detectada", { leader });
      }
    } else {
      const current = status.get(leader);
      if (!current.up) {
        leaderFailures += 1;
        log("warn", "la primaria no responde", {
          leader,
          failures: leaderFailures,
          err: current.error,
        });
        const candidate = NODES.find((n) => {
          const s = status.get(n.name);
          return n.name !== leader && s.up && s.standby;
        });
        // Dos testigos: la sonda no llega a la primaria y la réplica perdió su stream de WAL.
        // Basta una falla; si la réplica sigue recibiendo, se exigen FAILURE_THRESHOLD.
        const confirmed = candidate && status.get(candidate.name).receiver !== "streaming";
        if (leaderFailures >= FAILURE_THRESHOLD || confirmed) {
          if (candidate) {
            const promotedAt = Date.now();
            await run(candidate, "select pg_promote(true, 10)");
            await setSyncNames(candidate, "");
            log("warn", "failover: réplica promovida a primaria", {
              from: leader,
              to: candidate.name,
              promoteMs: Date.now() - promotedAt,
              failures: leaderFailures,
            });
            leader = candidate.name;
            saveLeader(leader);
            leaderFailures = 0;
            withoutStandby = 0;
          } else if (leaderFailures === FAILURE_THRESHOLD) {
            log("error", "primaria caída y sin réplica sana para promover", {
              leader,
              err: current.error,
            });
          }
        }
      } else {
        leaderFailures = 0;
        for (const node of NODES) {
          const s = status.get(node.name);
          if (node.name !== leader && s.up && !s.standby && !s.fenced) {
            await fence(node).catch((error) =>
              log("error", "no se pudo aislar el nodo", { node: node.name, err: error.message }),
            );
          }
        }
        if (current.streaming === 0) {
          withoutStandby += 1;
          if (withoutStandby >= FAILURE_THRESHOLD && current.sync_names !== "") {
            await setSyncNames(byName(leader), "");
          }
        } else {
          withoutStandby = 0;
          if (current.sync_names === "") await setSyncNames(byName(leader), SYNC_NAMES);
        }
      }
    }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)));
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
main().catch((error) => {
  log("error", "monitor detenido", { err: error.message });
  process.exit(1);
});
