# ADR-03 · Reserva con bloqueo pesimista

- **Estado:** Aceptado · **ASR:** ASR03 Consistencia

## Contexto
0 % de sobreventa ante solicitudes simultáneas sobre la misma entrada. La reserva es exclusiva por 10 min;
sin pago, se libera en < 500 ms.

## Decisión
- Reservar con `SELECT … FOR UPDATE` sobre la butaca (o el contador del tipo de entrada en sectores
  generales) dentro de una transacción, y `expira_en = now() + interval '10 minutes'`.
- **Expiración perezosa**: una reserva vencida deja de contar en cuanto se consulta (las consultas filtran
  `expira_en > now()`), sin depender de un job. Un barrido periódico limpia filas viejas.
- Sectores generales: `UPDATE tipo SET reservadas = reservadas + n WHERE vendidas + reservadas + n <= capacidad`.
- Restricción única parcial en BD: una sola reserva activa o venta por (fecha, butaca).
- Liberación explícita (pago rechazado/cancelado) en la misma transacción que actualiza la orden.

## Consecuencias
- (+) Consistencia fuerte; la BD es la última línea de defensa.
- (−) Más latencia y contención en los peaks. Se mitiga con la fila virtual (ADR-06), que limita
  cuántos compradores reservan al mismo tiempo.
