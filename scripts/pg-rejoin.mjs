#!/usr/bin/env node
// Reincorpora como réplica al nodo de PostgreSQL que perdió el rol de primaria (ADR-01).
// Tras un failover, `pg-failover` promovió al otro nodo y aisló (o dejó caído) a este. Aquí se
// borra su copia de datos y se clona desde la primaria actual con pg_basebackup; al arrancar queda
// como hot standby y el monitor vuelve a activar la replicación síncrona.
//   npm run infra:pg-rejoin
import { execFileSync } from "node:child_process";

const COMPOSE = ["compose", "-f", "infra/docker-compose.yml"];
const NODES = ["postgres-primary", "postgres-replica"];
const SLOT = "replica1";
const REPLICATION_PASSWORD = process.env.REPLICATION_PASSWORD ?? "replicator-dev-password";

const docker = (args, options = {}) =>
  execFileSync("docker", [...COMPOSE, ...args], { encoding: "utf8", ...options });

/** `true` si el nodo está arriba y acepta escrituras sin estar aislado; `undefined` si no responde. */
function role(node) {
  try {
    const out = docker([
      "exec",
      "-T",
      node,
      "psql",
      "-U",
      "postgres",
      "-tAc",
      "select pg_is_in_recovery()::text || ',' || current_setting('default_transaction_read_only')",
    ]).trim();
    const [standby, readOnly] = out.split(",");
    return { up: true, primary: standby === "false" && readOnly === "off" };
  } catch {
    return { up: false, primary: false };
  }
}

const roles = Object.fromEntries(NODES.map((node) => [node, role(node)]));
const leader = NODES.find((node) => roles[node].primary);
if (!leader) {
  console.error(
    "No hay una primaria que acepte escrituras; revisa `docker compose logs pg-failover`.",
  );
  process.exit(1);
}
const stale = NODES.filter(
  (node) => node !== leader && !(roles[node].up && !roles[node].primary && isStreaming(node)),
);
if (stale.length === 0) {
  process.stdout.write(`Nada que hacer: ${leader} es la primaria y la réplica está al día.\n`);
  process.exit(0);
}

function isStreaming(node) {
  try {
    return (
      docker([
        "exec",
        "-T",
        node,
        "psql",
        "-U",
        "postgres",
        "-tAc",
        "select status from pg_stat_wal_receiver",
      ]).trim() === "streaming"
    );
  } catch {
    return false;
  }
}

for (const node of stale) {
  process.stdout.write(`Reincorporando ${node} como réplica de ${leader}…\n`);
  docker(["stop", node], { stdio: "inherit" });
  // El slot de la réplica anterior (si quedó inactivo) se recrea con pg_basebackup -C.
  docker(
    [
      "exec",
      "-T",
      leader,
      "psql",
      "-U",
      "postgres",
      "-tAc",
      `select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = '${SLOT}' and not active`,
    ],
    { stdio: "ignore" },
  );
  const clone = [
    'rm -rf "$PGDATA"/* "$PGDATA"/.[!.]* 2>/dev/null || true',
    `export PGPASSWORD='${REPLICATION_PASSWORD}'`,
    `pg_basebackup -h ${leader} -p 5432 -U replicator -D "$PGDATA" -X stream -C -S ${SLOT} -R --checkpoint=fast`,
    // application_name identifica al standby en synchronous_standby_names.
    `echo "primary_conninfo = 'host=${leader} port=5432 user=replicator password=${REPLICATION_PASSWORD} application_name=${SLOT}'" >> "$PGDATA/postgresql.auto.conf"`,
    // Sin el aislamiento que le puso el monitor (el clon trae la configuración de la primaria).
    `sed -i "/default_transaction_read_only/d" "$PGDATA/postgresql.auto.conf"`,
    'chmod 0700 "$PGDATA"',
  ].join(" && ");
  docker(
    ["run", "--rm", "--no-deps", "-u", "postgres", "--entrypoint", "bash", node, "-c", clone],
    {
      stdio: "inherit",
    },
  );
  docker(["up", "-d", "--wait", node], { stdio: "inherit" });
  process.stdout.write(`${node}: réplica en streaming de ${leader}.\n`);
}
