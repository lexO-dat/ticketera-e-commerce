# Pendientes de infraestructura

La hoja de ruta ([`roadmap.md`](roadmap.md)) está completa. Esto es lo que queda para pasar del entorno
local (`infra/docker-compose.yml`) a un despliegue real. Ninguno bloquea el desarrollo ni las pruebas.

## Disponibilidad

- [ ] **RabbitMQ en clúster** (3 nodos, colas quorum replicadas). Hoy es un solo nodo: si cae, los
      productores siguen escribiendo en su outbox y los eventos se publican al volver, así que se
      atrasan pero no se pierden. Con clúster, el retraso desaparece. Agregar el escenario `rabbitmq` a
      `tools/failover-test`.
- [ ] **Monitor de failover de PostgreSQL redundante.** `pg-failover` es una sola instancia: si cae, la
      base sigue funcionando pero no hay failover automático. Opciones: dos monitores con elección de
      líder (lock en una tercera fuente de verdad, p. ej. etcd) o el servicio de base de datos gestionado
      por la propia infraestructura (ADR nuevo).
- [ ] **Reincorporación automática de la primaria caída.** Hoy es manual a propósito
      (`npm run infra:pg-rejoin`). Automatizarla con `pg_rewind` cuando el monitor sea redundante.
- [ ] **Dos zonas reales.** En local todo comparte una máquina y una red de Docker. Desplegar cada
      réplica (servicios, Postgres, Redis, Sentinel) en una zona distinta, con el balanceador repartiendo
      entre ambas.
- [ ] **Balanceador del borde redundante.** Nginx es una sola instancia: en producción, dos nodos con
      IP flotante (keepalived) o el balanceador del proveedor.

## Escalabilidad y pruebas

- [ ] **Prueba de carga distribuida en infraestructura dedicada.** Los 10.000 usuarios se probaron en
      un portátil (simulador y servicios en la misma máquina). Repetir con los bots repartidos en varias
      máquinas y medir el techo real (usuarios, reservas por segundo, latencias p99).
- [ ] **Autoescalado (ADR-02).** Las réplicas son fijas (2 por servicio). Escalar por CPU y por largo de
      cola de la fila.
- [ ] **Réplica de lectura para consultas pesadas** (panel admin, auditorías), para no cargar la
      primaria en los peaks.

## Operación

- [ ] **Secretos en un gestor de secretos** (no variables con valores por defecto de desarrollo):
      claves EdDSA de identity, queue y tickets, `INTERNAL_API_TOKEN`, contraseñas de Postgres, Redis y
      RabbitMQ, clave SMTP.
- [ ] **Certificados TLS reales** (hoy autofirmados) y TLS también entre servicios y hacia Postgres y
      Redis.
- [ ] **Observabilidad:** métricas (Prometheus), trazas distribuidas con el `x-request-id` que ya
      propaga el gateway, alertas de failover, de DLQ con mensajes y de replicación detenida.
- [ ] **Respaldos y restauración probada** de PostgreSQL (base completa y WAL continuo para restaurar
      a un instante).
- [ ] **Imágenes publicadas en un registro** y despliegue continuo desde CI.
