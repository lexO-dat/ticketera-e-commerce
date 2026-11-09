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

| Escenario          | Se bota                 | Quién toma el relevo                                                     |
| ------------------ | ----------------------- | ------------------------------------------------------------------------ |
| `service:catalog`  | una réplica de catalog  | la otra réplica (DNS de Docker + reintento de conexión)                  |
| `service:identity` | una réplica de identity | ídem                                                                     |
| `service:orders`   | una réplica de orders   | ídem                                                                     |
| `web`              | una réplica de la web   | Nginx reintenta la conexión en la otra (sonda: página `/tienda` por SSR) |
| `gateway`          | una réplica del gateway | Nginx reintenta la conexión en la otra                                   |
| `redis`            | Redis primario          | Sentinel promueve la réplica; ioredis se reconecta al nuevo primario     |
| `postgres`         | PostgreSQL primaria     | `pg-failover` promueve la réplica; el pool de commons la encuentra       |

## Resultados de referencia (portátil, todo en Docker)

Ventana = desde el inicio de la primera solicitud fallida o lenta (> 1 s) hasta el fin de la
última, es decir, lo que percibe el usuario:

| Escenario                              | Peor ventana | Solicitudes fallidas                                          |
| -------------------------------------- | ------------ | ------------------------------------------------------------- |
| Réplica de catalog / identity / orders | 0 s          | 0                                                             |
| Réplica del gateway                    | ≤ 3,3 s      | 0 (Nginx espera 1 s la conexión y reintenta en la otra)       |
| Réplica de la web                      | ≤ 2,0 s      | 0 (Nginx reintenta en la otra réplica)                        |
| Redis primario                         | ≤ 2,6 s      | 1 lectura del carro (500); el carro se conserva               |
| PostgreSQL primaria                    | ≤ 1,5 s      | 0–1 (el monitor confirma con la réplica y promueve en ~0,3 s) |
| Réplica de PostgreSQL                  | ≤ 3,1 s      | 0 (las escrituras esperan hasta que se pasa a asíncrona)      |

Lo que hubo que resolver para llegar ahí (ADR-10): dentro de Docker, resolver el nombre de un
contenedor caído tarda ~5 s y conectar a su IP vieja ~3 s. Con varias resoluciones colgadas se
satura el pool de hilos de Node, y Sentinel entraba en modo TILT. Por eso los nodos con estado
usan IP fijas y los clientes tienen timeouts cortos (conexión a Postgres 1,5 s, comandos de Redis
1 s).

Después de cada escenario el componente vuelve: `docker compose up -d`, o en Postgres
`npm run infra:pg-rejoin`, que lo suma como réplica de la nueva primaria. Diseño en
[ADR-10](../../docs/adr/ADR-10-failover-postgres-redis.md).
