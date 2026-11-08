# failover-test — prueba de failover (ASR01)

Mide la meta de ADR-01: failover en **≤ 5 s sin perder la sesión ni el carro**. Con el stack
levantado (`npm run infra:up`), la prueba crea dos cuentas y agrega un producto al carro. Luego
deja corriendo sondas por el borde (Nginx → gateway → servicios) y bota un componente con
`docker kill`, que es una caída abrupta y no un apagado limpio:

| Sonda          | Qué ejercita                                               | Cada   |
| -------------- | ---------------------------------------------------------- | ------ |
| Catálogo       | Lectura pública (catalog + caché Redis + Postgres)         | 250 ms |
| Carro          | Redis vía orders; **falla también si el carro ya no está** | 250 ms |
| Mis órdenes    | Lectura en Postgres                                        | 250 ms |
| Renovar sesión | Escritura en Postgres (rotación del refresh token)         | 2 s    |

La ventana de cada sonda va del primer al último error posterior a la caída. La prueba pasa si
todas las ventanas son ≤ `--budget-seconds` (5) y las sondas se recuperan.

```bash
npm run test:failover -- --scenario all                 # todos, en orden
npm run test:failover -- --scenario postgres,redis      # algunos
```

| Escenario          | Se bota                 | Quién toma el relevo                                                 |
| ------------------ | ----------------------- | -------------------------------------------------------------------- |
| `service:catalog`  | una réplica de catalog  | la otra réplica (DNS de Docker + reintento de conexión)              |
| `service:identity` | una réplica de identity | ídem                                                                 |
| `service:orders`   | una réplica de orders   | ídem                                                                 |
| `gateway`          | una réplica del gateway | Nginx reintenta la conexión en la otra                               |
| `redis`            | Redis primario          | Sentinel promueve la réplica; ioredis se reconecta al nuevo primario |
| `postgres`         | PostgreSQL primaria     | `pg-failover` promueve la réplica; el pool de commons la encuentra   |

Después de cada escenario el componente vuelve: `docker compose up -d`, o en Postgres
`npm run infra:pg-rejoin`, que lo suma como réplica de la nueva primaria. Diseño en
[ADR-10](../../docs/adr/ADR-10-failover-postgres-redis.md).
