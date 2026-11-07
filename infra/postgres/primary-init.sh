#!/bin/bash
# Inicialización de la primaria (solo corre la primera vez, con el volumen vacío).
# - Rol de replicación + slot físico para la réplica.
# - Una base de datos y un rol por servicio (ADR-05: cada servicio es dueño de su esquema y no
#   puede conectarse a la base de otro).
# - Replicación síncrona (ADR-01) activada al final, para no bloquear esta inicialización.
set -euo pipefail

psql=(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres)

"${psql[@]}" <<-SQL
  create role replicator with replication login password '${REPLICATION_PASSWORD}';
  select pg_create_physical_replication_slot('replica1');
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"

for db in ${SERVICE_DATABASES}; do
  var="PG_PASSWORD_$(echo "$db" | tr '[:lower:]-' '[:upper:]_')"
  password="${!var:-${db}-dev-password}"
  echo "creando base de datos y rol: $db"
  "${psql[@]}" <<-SQL
    create role "$db" with login password '${password}';
    create database "$db" owner "$db";
    revoke all on database "$db" from public;
SQL
  "${psql[@]}" --dbname "$db" <<-SQL
    revoke all on schema public from public;
    alter schema public owner to "$db";
SQL
done

if [ -n "${PG_SYNC_STANDBY_NAMES:-}" ]; then
  "${psql[@]}" -c "alter system set synchronous_standby_names = '${PG_SYNC_STANDBY_NAMES}'"
fi
