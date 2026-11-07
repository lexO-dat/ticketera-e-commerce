# queue-service — Fila virtual (RF16 · ADR-06)

Absorbe el pico de apertura de ventas (ASR02) y protege la reserva (ASR03): solo un número controlado
de compradores llega al mismo tiempo a `inventory` y `orders`. Reemplaza la simulación actual de
`src/lib/queue.functions.ts` (posición con `Math.random` y avance por tiempo).

## Requisitos

1. **Orden justo**: FIFO por llegada. Quienes llegan antes de la apertura (prefila) se **aleatorizan** al
   abrir, para que no gane quien refresca más rápido.
2. **Admisión controlada**: nunca más de `concurrent_slots` compradores activos por evento.
3. **Ventana de compra**: cada admitido tiene `window_minutes` para comprar; al vencer pierde el cupo.
4. **Obligatoria**: sin admisión válida no se puede reservar ni pagar entradas de un evento con fila.
5. **Transparente**: posición, cantidad de personas delante y ETA calculada con la tasa real.
6. **Escalable**: ≥ 10.000 usuarios en espera por evento con varias réplicas del servicio.
7. **Anti-abuso**: un turno por usuario y evento; rate limiting; tokens no transferibles.
8. **Real y verificable**: un simulador con bots demuestra el comportamiento bajo carga.

## Configuración por evento (`catalog` es dueño; `queue` la cachea)

| Campo | Descripción |
| --- | --- |
| `enabled` | Activa la fila para el evento |
| `opens_at` | Apertura de la venta; antes de esto los turnos quedan en **prefila** |
| `concurrent_slots` | Máximo de admitidos activos simultáneamente |
| `window_minutes` | Duración de la ventana de compra tras ser admitido |
| `admit_batch_max` | Máximo de admisiones por tick (suaviza picos) |
| `waiting_message` | Texto para la sala de espera |

## Modelo de datos (Redis, replicado)

Claves por evento `{e}` (el hash tag `{}` mantiene todo el evento en el mismo slot si se usa Redis Cluster):

| Clave | Tipo | Contenido |
| --- | --- | --- |
| `q:{e}:seq` | STRING (INCR) | Contador de llegada |
| `q:{e}:waiting` | ZSET | `member = userId`, `score = número de llegada` |
| `q:{e}:prequeue` | SET | Usuarios que llegaron antes de `opens_at` |
| `q:{e}:active` | ZSET | `member = userId`, `score = expira_en (ms)` |
| `q:{e}:turn:{userId}` | HASH | `state`, `seq`, `joinedAt`, `admittedAt`, `expiresAt`, `jti`, `lastSeen` |
| `q:{e}:jti:{jti}` | STRING con TTL | Admisión vigente (para revocar / validar) |
| `q:{e}:rate` | STRING | Tasa de admisión suavizada (EWMA), para la ETA |
| `q:{e}:leader` | STRING (`SET NX PX`) | Lock de líder del admisor |

Cada operación que toca varias claves (join, admitir, completar) se hace con un **script Lua** para que
sea atómica.

Persistencia: el estado vivo está en Redis. Los hechos relevantes (`TurnoCreado`, `TurnoAdmitido`,
`TurnoVencido`, `TurnoCompletado`) se publican al broker para auditoría y métricas.

## API (vía gateway, usuario autenticado)

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/queue/events/{eventId}/join` | Idempotente: crea el turno o devuelve el existente |
| `GET` | `/queue/events/{eventId}/status` | Estado, posición, delante, ETA; header `Retry-After` |
| `POST` | `/queue/events/{eventId}/leave` | Abandona la fila |
| `POST` | `/internal/queue/complete` | (orders) marca el turno completado y libera el cupo |
| `GET/PUT` | `/admin/queue/events/{eventId}` | Ver y ajustar configuración; métricas en vivo |
| `POST` | `/admin/queue/events/{eventId}/pause` | Pausa la admisión (incidente) |

Respuesta de `status` cuando el usuario es admitido: `state: "ADMITTED"`, `admissionToken`,
`expiresAt`. El token se envía después como `X-Admission-Token` en `inventory` y `orders`.

## Algoritmo del admisor

Corre en todas las réplicas; solo actúa la que tiene el lock `q:{e}:leader` (renovado cada tick).

```
cada 1 s, por cada evento con fila activa y abierta:
  1. si es la apertura: mover la prefila a waiting en orden aleatorio (Fisher–Yates con crypto)
  2. ZREMRANGEBYSCORE active -inf now        → vencidos (publica TurnoVencido)
  3. libres = concurrent_slots − ZCARD active
  4. n = min(libres, admit_batch_max)
  5. ZPOPMIN waiting n                         → candidatos
  6. descartar candidatos sin heartbeat reciente (ABANDONADO) y volver a 5 si sobran cupos
  7. por cada candidato: jti = randomUUID; ZADD active (now + ventana); SET jti (TTL ventana);
     estado ADMITTED; publica TurnoAdmitido
  8. actualizar EWMA de admisiones/s
```

Posición = `ZRANK waiting userId` (O(log n)). ETA = `posición / tasa_EWMA`, con un mínimo razonable.

## Token de admisión

JWT firmado con **EdDSA** (clave propia del servicio; la pública se publica en un JWKS interno):

```json
{ "iss": "queue", "sub": "<userId>", "evt": "<eventId>", "jti": "<uuid>", "exp": <ventana> }
```

- El **gateway** verifica firma, `exp`, que `sub` coincida con el usuario del JWT de acceso y que `evt`
  corresponda al recurso pedido.
- `inventory` y `orders` comprueban además que el `jti` siga vigente en Redis (permite expulsar y evita
  reutilizar un token después de completar la compra).
- Sin fila activa para el evento, no se exige token.

## Cliente (sala de espera)

- Llama `join` una sola vez y luego `status` respetando `Retry-After` (2–10 s, según la posición) con jitter.
- El estado se guarda en el servidor: recargar la página **no** hace perder el turno (hoy el prototipo
  avisa lo contrario).
- Al ser admitido muestra la cuenta regresiva real con `expiresAt` del servidor.

## Anti-abuso

- Requiere sesión iniciada: un turno por usuario y evento (`join` idempotente).
- Rate limiting en gateway por IP y por usuario para `join`/`status`.
- Token ligado a `sub` y `evt`; no sirve en otra cuenta ni en otro evento.
- Límites de compra por usuario y evento en `orders` (independiente de la fila).

## Falla de Redis

Si Redis no responde, `join`/`status` devuelven `503` con `Retry-After`; el gateway **no** deja pasar
reservas de eventos con fila sin token verificable. Preferimos disponibilidad parcial antes que sobreventa.

## Simulador (`tools/queue-simulator`)

Herramienta de línea de comandos que genera bots contra el gateway:

```
queue-simulator --event lumen-tour-santiago --bots 10000 --ramp 60s \
                --accept-ratio 0.8 --seat-strategy random
```

Cada bot:
1. Crea o reutiliza un usuario de prueba (`bot-<n>@acceptme.com` o `@rejectme.com` según `--accept-ratio`).
2. Inicia sesión, entra a la fila y consulta el estado respetando `Retry-After`.
3. Al ser admitido, intenta reservar butacas (compite con los demás bots), confirma la compra y paga.

Al terminar reporta y **verifica**:
- Admitidos activos nunca > `concurrent_slots` (muestreo durante la corrida).
- **0 sobreventas**: ninguna butaca con más de una venta; vendidas ≤ capacidad por tipo.
- Pagos `@acceptme.com` → orden confirmada y entradas emitidas; `@rejectme.com` → reserva liberada.
- Latencias p50/p95/p99 de `status`, reserva y checkout; throughput de admisión.
- Código de salida ≠ 0 si alguna verificación falla (sirve en CI).

## Pruebas obligatorias

- Concurrencia de `join` del mismo usuario (un solo turno).
- Dos réplicas del admisor no admiten de más (lock de líder + scripts Lua).
- Vencimiento de ventana libera cupo y revoca el `jti`.
- Token de otro usuario o evento rechazado por gateway e inventory.
