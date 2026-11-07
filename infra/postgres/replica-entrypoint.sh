#!/bin/bash
# Réplica en streaming de la primaria (hot standby, solo lectura).
# La primera vez clona la primaria con pg_basebackup; después solo arranca.
set -euo pipefail

: "${PRIMARY_HOST:=postgres-primary}"
: "${REPLICA_NAME:=replica1}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "réplica: esperando a la primaria ${PRIMARY_HOST}"
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -U replicator >/dev/null 2>&1; do sleep 1; done

  echo "réplica: clonando la primaria"
  export PGPASSWORD="$REPLICATION_PASSWORD"
  pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator -D "$PGDATA" \
    -X stream -S "$REPLICA_NAME" -R --checkpoint=fast --progress

  # application_name identifica a esta réplica en synchronous_standby_names de la primaria.
  cat >> "$PGDATA/postgresql.auto.conf" <<-CONF
primary_conninfo = 'host=${PRIMARY_HOST} port=5432 user=replicator password=${REPLICATION_PASSWORD} application_name=${REPLICA_NAME}'
primary_slot_name = '${REPLICA_NAME}'
CONF
  chmod 0700 "$PGDATA"
fi

# Parámetros como max_connections deben ser >= a los de la primaria: llegan como argumentos.
exec postgres -c hot_standby=on -c listen_addresses='*' "$@"
