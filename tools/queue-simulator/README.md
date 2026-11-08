# queue-simulator — prueba de carga de la fila y la reserva

Bots reales contra el gateway (sin atajos): se registran e inician sesión en identity, entran a la
fila, consultan su estado respetando `Retry-After` (con jitter) y, al ser admitidos, compiten por
butacas y cupos en inventory con su token de admisión. Mezcla `@acceptme.com` (conserva la reserva;
el cobro llega en la Fase 5) y `@rejectme.com` (la libera, como un pago rechazado); una fracción
abandona la fila para comprobar que el admisor la descarta.

Verifica y sale con código ≠ 0 si falla:

- Admitidos activos nunca superan `concurrentSlots` (muestreo cada segundo).
- 0 sobreventas: auditoría de inventory (capacidad, butacas duplicadas, contadores).
- Ninguna butaca entregada a dos bots.

```bash
npm run infra:up
npm run simulate:queue -- --event lumen-tour-santiago --bots 2000 --slots 100 --ramp 30
```

| Opción                 | Por defecto             | Descripción                                                                                                                                       |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bots` / `--ramp`    | 500 / 20 s              | Cantidad de bots y tiempo en que van llegando                                                                                                     |
| `--slots` / `--window` | config. del evento      | Ajusta la fila durante la corrida (vía catalog) y la restaura al final                                                                            |
| `--accept-ratio`       | 0.8                     | Fracción de cuentas `@acceptme.com`                                                                                                               |
| `--abandon-ratio`      | 0.05                    | Fracción que deja de consultar                                                                                                                    |
| `--hold-seconds`       | 3                       | Tiempo que el bot "paga" antes de liberar el cupo de la fila                                                                                      |
| `--keep-reservations`  | no                      | Por defecto libera las reservas al terminar                                                                                                       |
| `--gateway`            | `http://127.0.0.1:3000` | El simulador corre en la red de confianza del gateway: cada bot usa su propia IP (`X-Forwarded-For`) para que los límites por IP apliquen por bot |

Las cuentas creadas se guardan en `.data/users.json` (ignorado por git) para reutilizarlas.

## Resultado de referencia (portátil, todo en Docker)

2.000 bots, 100 cupos, llegada en 30 s, Lumen Tour (742 butacas + cancha general):

| Métrica                     | Valor                                       |
| --------------------------- | ------------------------------------------- |
| Máx. admitidos activos      | 100 / 100                                   |
| Máx. en espera              | 1.648                                       |
| Admitidos / reservas        | 1.892 / 1.362 (108 abandonos descartados)   |
| Choques por la misma butaca | 20 (409 `SEAT_TAKEN`), 0 butacas duplicadas |
| Auditoría de inventory      | OK (0 sobreventas, contadores sin deriva)   |
| Latencia `status`           | p50 13 ms · p95 778 ms                      |
| Latencia reserva            | p50 29 ms · p95 1,4 s                       |

Las colas de latencia (p95–p99) de login y reserva vienen de la CPU del portátil saturada por 2.000
verificaciones Argon2 en 30 s compartiendo máquina con todos los contenedores; la meta de 10.000
usuarios (ASR02) se mide en la Fase 8 con infraestructura dedicada.
