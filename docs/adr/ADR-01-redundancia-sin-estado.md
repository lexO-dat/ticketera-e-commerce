# ADR-01 · Redundancia sin estado

- **Estado:** Aceptado · **ASR:** ASR01 Disponibilidad

## Contexto
Catálogo y checkout deben estar disponibles el 99,9 % del tiempo. Ante la caída de una instancia o de la
base de datos, el tráfico debe pasar al respaldo en ≤ 5 s sin que el usuario pierda la sesión ni el carrito.

## Decisión
- Servicios en contenedores **sin estado**, en 2 zonas, tras un balanceador con health checks
  (`/health/live`, `/health/ready`).
- PostgreSQL con **réplica síncrona** y failover automático.
- Sesión (refresh tokens), carrito y fila virtual en **Redis replicado**; nada de estado de usuario en memoria del proceso.

## Consecuencias
- (+) Cualquier réplica atiende cualquier request; caer una zona no corta la venta.
- (−) Menos simplicidad; más costo de infraestructura y complejidad operativa.
- Regla: todo servicio debe poder morir en cualquier momento (apagado limpio con `SIGTERM`, operaciones idempotentes).
