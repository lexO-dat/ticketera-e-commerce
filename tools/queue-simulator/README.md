# queue-simulator — prueba de carga de la fila, la reserva y el pago

Bots reales contra el gateway (sin atajos): se registran e inician sesión en identity, entran a la
fila, consultan su estado respetando `Retry-After` (con jitter) y, al ser admitidos, compiten por
butacas y cupos en inventory con su token de admisión. Luego **pagan de verdad**: carro → checkout
idempotente → formulario de webpay-mock → retorno a payments → orden. Mezcla `@acceptme.com` (la
orden debe quedar confirmada) y `@rejectme.com` (debe cancelarse y liberar la reserva); una fracción
abandona la fila para comprobar que el admisor la descarta.

Verifica y sale con código ≠ 0 si falla:

- Admitidos activos nunca superan `concurrentSlots` (muestreo cada segundo).
- 0 sobreventas: auditoría de inventory (capacidad, butacas duplicadas, contadores).
- Ninguna butaca entregada a dos bots.
- Cada orden termina como corresponde a su email y el ledger de payments queda balanceado.

```bash
npm run infra:up
npm run simulate:queue -- --event lumen-tour-santiago --bots 2000 --slots 100 --ramp 30
```

| Opción                 | Por defecto             | Descripción                                                                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--bots` / `--ramp`    | 500 / 20 s              | Cantidad de bots y tiempo en que van llegando                                                                                   |
| `--slots` / `--window` | config. del evento      | Ajusta la fila durante la corrida (vía catalog) y la restaura al final                                                          |
| `--accept-ratio`       | 0.8                     | Fracción de cuentas `@acceptme.com`                                                                                             |
| `--abandon-ratio`      | 0.05                    | Fracción que deja de consultar                                                                                                  |
| `--hold-seconds`       | 3                       | Espera máxima antes de pagar                                                                                                    |
| `--keep-orders`        | no                      | Por defecto reembolsa (de verdad) las órdenes confirmadas al terminar, para que la próxima corrida tenga cupo                   |
| `--gateway`            | `http://127.0.0.1:3000` | Red de confianza del gateway: cada bot usa su propia IP (`X-Forwarded-For`) para que los límites por IP apliquen por bot        |
| `--webpay`             | `http://127.0.0.1:3005` | Formulario de webpay-mock directo (por Nginx el límite de borde por IP frenaría a todos los bots, que comparten la IP del host) |

Las cuentas creadas se guardan en `.data/users.json` (ignorado por git) para reutilizarlas.

## Resultados de referencia (portátil, todo en Docker)

**Con pago (Fase 5)** — 500 bots, 50 cupos, llegada en 20 s:

| Métrica                        | Valor                                                   |
| ------------------------------ | ------------------------------------------------------- |
| Máx. admitidos activos         | 50 / 50                                                 |
| Órdenes                        | 371 confirmadas (@acceptme) · 93 canceladas (@rejectme) |
| Resultado inesperado           | 0                                                       |
| Auditoría de inventory, ledger | OK, OK                                                  |
| Latencia reserva / checkout    | p50 32 ms / 93 ms · p95 90 ms / 224 ms                  |
| Retorno → orden resuelta       | p50 383 ms · p95 680 ms (saga asíncrona por RabbitMQ)   |

**Solo fila y reserva (Fase 4)** — 2.000 bots, 100 cupos, llegada en 30 s: máx. 100/100 activos,
1.648 en espera, 1.892 admitidos, 20 choques por la misma butaca resueltos con 409, 0 butacas
duplicadas. `status` p50 13 ms; las colas p95–p99 de login y reserva vinieron de la CPU del portátil
saturada por 2.000 verificaciones Argon2 en 30 s junto a todos los contenedores. La meta de 10.000
usuarios (ASR02) se mide en la Fase 8 con infraestructura dedicada.
