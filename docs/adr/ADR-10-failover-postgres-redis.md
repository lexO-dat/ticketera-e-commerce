# ADR-10 · Failover propio de PostgreSQL y Redis Sentinel

- **Estado:** Aceptado · **ASR:** ASR01 Disponibilidad · Implementa ADR-01

## Contexto

ADR-01 pide failover automático en ≤ 5 s sin perder la sesión ni el carro. Hasta la Fase 7 había
réplicas (PostgreSQL síncrona, Redis asíncrona), pero nada las promovía. Además, con
`synchronous_standby_names` fijo, la caída de la réplica bloqueaba **todas** las escrituras de la
primaria.

Las herramientas habituales no cumplen el plazo o agregan un sistema más que operar:

- **Patroni** (con etcd) exige `ttl ≥ 20 s` para el lock de líder: una primaria que muere sin avisar
  no se reemplaza antes de ~20 s.
- **pg_auto_failover** necesita un nodo monitor con su propio Postgres y sus plazos por defecto
  también rondan los 20 s.
- Un proxy (HAProxy, PgBouncer) delante de la base sería otro punto único de falla en la ruta de
  datos.

## Decisión

**PostgreSQL**

- Monitor propio `pg-failover` (`infra/pg-failover`): sondea los nodos cada 500 ms; cuando la
  primaria no responde y la réplica confirma que perdió el stream de WAL, promueve la réplica
  (`pg_promote`) y la deja en replicación asíncrona hasta que tenga un standby.
- **Aislamiento (fencing):** si la primaria vieja reaparece aceptando escrituras, el monitor le fija
  `default_transaction_read_only = on` y corta sus conexiones.
- **Sin proxy en la ruta de datos:** el pool de `@shared/commons` recibe los nodos de respaldo en la
  URL (`?failover_hosts=`) y en cada conexión nueva verifica que el nodo acepte escrituras (como
  `target_session_attrs=read-write` de libpq). Descarta réplicas y nodos aislados.
- Si la réplica cae, el monitor degrada la primaria a replicación asíncrona para que las escrituras
  no se detengan, y la vuelve a síncrona cuando hay un standby transmitiendo.
- La primaria vieja se reincorpora como réplica con `npm run infra:pg-rejoin` (borra su copia y la
  clona con `pg_basebackup`). Es un paso manual a propósito: un nodo que cayó no vuelve solo a la
  replicación.

**Redis**

- Tres Redis Sentinel (quórum 2, `down-after-milliseconds 1000`). Los clientes (ioredis en Node,
  redis-py en notifications) preguntan a los Sentinel quién es el primario
  (`?sentinels=…&master=ticketera` en `REDIS_URL`) y se reconectan solos tras un failover. El
  primario viejo vuelve como réplica sin intervención.

**Borde**

- El gateway corre en dos réplicas. Nginx resuelve el DNS cada 2 s y, si una réplica no acepta la
  conexión, reintenta en otra (`proxy_next_upstream`, conexión en 1 s).

**Medido** (`npm run test:failover`, ver `tools/failover-test/README.md`): primaria de
PostgreSQL ≤ 1,5 s, Redis ≤ 2,6 s, réplica del gateway ≤ 3,3 s y réplica de un servicio 0 s, sin
perder la sesión ni el carro. Para lograrlo, los nodos con estado usan **IP fijas** (resolver el
nombre de un contenedor caído tarda ~5 s en el DNS de Docker, satura el pool de hilos de Node y
deja a Sentinel en modo TILT). El monitor promueve con una sola sonda fallida si la réplica
confirma que perdió el stream de WAL; si no, exige 3 fallas seguidas.

## Consecuencias

- (+) El failover de la base, de Redis y de cualquier réplica de servicio queda dentro del
  presupuesto de ADR-01; `npm run test:failover` lo mide.
- (+) La replicación síncrona sigue garantizando 0 pérdida de transacciones confirmadas al
  promover.
- (−) El monitor es un componente único. Si cae, no hay failover automático, pero la ruta de datos
  sigue funcionando. En producción se reemplaza por un par con elección de líder o por
  infraestructura gestionada propia.
- (−) Durante la degradación a asíncrona (réplica caída), una falla de la primaria podría perder las
  últimas transacciones. Es el mismo compromiso que el `synchronous_mode` de Patroni.
- (−) Redis replica de forma asíncrona: un failover puede perder escrituras de los últimos
  milisegundos (carros o turnos recién modificados). La sesión (refresh tokens) vive en Postgres.
- (−) RabbitMQ sigue siendo un nodo único. Los productores usan outbox, así que su caída retrasa
  eventos pero no los pierde.
