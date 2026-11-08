#!/bin/sh
# Redis Sentinel (ADR-01, ADR-10): tres sentinels vigilan al primario; con quórum 2 eligen y
# promueven a la réplica en ~2 s y avisan a los clientes (ioredis / redis-py preguntan a los
# sentinels quién es el primario). Se vigila por IP (ver docker-compose.yml). Sentinel reescribe
# su archivo con el estado: solo se genera la primera vez.
set -eu

CONF=/data/sentinel.conf
if [ ! -f "$CONF" ]; then
  # Tras un failover el primario puede ser cualquiera de los nodos: se vigila al que hoy lo es.
  MASTER="${MASTER_HOST}"
  for node in ${REDIS_NODES:-}; do
    role=$(redis-cli -h "$node" -a "$REDIS_PASSWORD" --no-auth-warning role 2>/dev/null | head -1 || true)
    if [ "$role" = "master" ]; then
      MASTER="$node"
      break
    fi
  done
  cat > "$CONF" <<CONF
port 26379
sentinel monitor ${MASTER_NAME:-ticketera} ${MASTER} 6379 ${QUORUM:-2}
sentinel auth-pass ${MASTER_NAME:-ticketera} ${REDIS_PASSWORD}
sentinel down-after-milliseconds ${MASTER_NAME:-ticketera} ${DOWN_AFTER_MS:-1000}
sentinel failover-timeout ${MASTER_NAME:-ticketera} 10000
sentinel parallel-syncs ${MASTER_NAME:-ticketera} 1
CONF
fi
exec redis-sentinel "$CONF"
