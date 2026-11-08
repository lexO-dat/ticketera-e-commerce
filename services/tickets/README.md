# tickets — entradas digitales y validación en puerta

RF11, RF12, RF15. Contrato:
[`packages/contracts/openapi/tickets.yaml`](../../packages/contracts/openapi/tickets.yaml). Público
vía gateway: `/tickets/*` → `/v1/*`. La app de validación está en
[`apps/scanner`](../../apps/scanner/README.md).

| Tema             | Implementación                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emisión (RF11)   | Asíncrona al consumir `OrdenConfirmada` (inbox): una entrada por unidad, idempotente por `(línea, unidad)`; etiqueta de butaca desde el plano de catalog. Publica `EntradasEmitidas` (outbox)                                                                                 |
| QR               | Token compacto firmado con EdDSA (`typ: ticket+jwt`, `tid`, `evd`); no se guarda, se genera al pedirlo. Clave en `TICKET_SIGNING_KEY`; JWKS público en `/.well-known/jwks.json`                                                                                               |
| Código manual    | 12 caracteres Crockford (`crypto.randomBytes`), por si el QR no se puede leer                                                                                                                                                                                                 |
| Check-in (RF15)  | Verifica la firma y marca con un solo `UPDATE … WHERE status = 'ISSUED' AND event_date_id = …`: dos puertas a la vez → una sola aceptada. Resultados `ACCEPTED`, `ALREADY_USED`, `VOIDED`, `WRONG_EVENT`, `INVALID`, todos auditados en `checkins`; publica `EntradaValidada` |
| Permisos         | Validar exige rol `staff`, `organizer` o `admin`; el comprador solo ve sus entradas (ajena = 404)                                                                                                                                                                             |
| Reembolsos       | `OrdenCancelada` (reembolso) anula las entradas aún no usadas: dejan de mostrar QR y se rechazan en puerta                                                                                                                                                                    |
| Historial (RF12) | `GET /v1/tickets` (opcional por orden); la web los muestra en la orden y en "Mi cuenta"                                                                                                                                                                                       |

```bash
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
  npm test -w @services/tickets
```
