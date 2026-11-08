# queue — fila virtual

Implementa [ADR-06](../../docs/adr/ADR-06-fila-virtual.md) según
[`docs/services/virtual-queue.md`](../../docs/services/virtual-queue.md). Reemplaza la simulación con
`Math.random` del prototipo. Contrato:
[`packages/contracts/openapi/queue.yaml`](../../packages/contracts/openapi/queue.yaml).
Público vía gateway: `/queue/*` → `/v1/*`; `/queue/admin/*` solo admin.

| Tema           | Implementación                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estado         | Solo Redis (claves `q:{eventId}:*`, mismo slot en Cluster). Recargar la página no pierde el turno                                                                                                |
| Atomicidad     | Scripts Lua (`src/scripts.ts`): `join` idempotente, admisión, término y apertura                                                                                                                 |
| Admisor        | Cada 1 s en todas las réplicas; por evento actúa solo la que tiene el lock de líder. Vence ventanas, revoca `jti`, admite hasta `concurrentSlots − activos` (máx. `admitBatchMax` por tick)      |
| Justicia       | FIFO por llegada. Antes de `opensAt` los turnos quedan en **prefila** y al abrir se barajan con `crypto.randomInt` (Fisher–Yates), delante de quienes llegan después                             |
| Abandono       | Quien deja de consultar `status` por `HEARTBEAT_TIMEOUT_SECONDS` pierde el turno al llegar al frente                                                                                             |
| ETA            | Posición / tasa real de admisión (EWMA); sin historial, cupos / ventana. `Retry-After` de 2, 5 o 10 s según cercanía                                                                             |
| Token          | JWT EdDSA (`typ: admission+jwt`, `sub`, `evt`, `jti`, `exp`) con la clave `ADMISSION_SIGNING_KEY`; JWKS en `/.well-known/jwks.json`. El `jti` vive en Redis mientras dura la ventana (revocable) |
| Configuración  | Dueño: catalog (`PUT /catalog/admin/events/:id/queue`). Se cachea 10 s y se actualiza al instante con `EventoActualizado`                                                                        |
| Fin del turno  | El comprador lo termina (`complete`) o, al crear su orden, queue consume `OrdenCreada` y libera el cupo al instante                                                                              |
| Falla de Redis | `join` / `status` responden 503 con `Retry-After`; inventory tampoco reserva sin poder verificar el turno: antes indisponible que sobreventa                                                     |
| Eventos        | `TurnoCreado`, `TurnoAdmitido`, `TurnoVencido`, `TurnoCompletado` directo al broker (auditoría y métricas, _best effort_): la verdad vive en Redis y el servicio no tiene BD para un outbox      |

La validación bajo carga está en [`tools/queue-simulator`](../../tools/queue-simulator/README.md).

```bash
npm run infra:up                      # ya incluye queue (2 réplicas)
cp services/queue/.env.example services/queue/.env && npm run dev -w @services/queue
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 npm test -w @services/queue
```
