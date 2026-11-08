# notifications — correos transaccionales (Python 3.12)

Consume eventos de RabbitMQ (`ticketera.events`) y envía correos por **SMTP estándar**: Mailpit en
desarrollo y, en producción, el servidor SMTP de cualquier proveedor configurando solo la API key. No
hay SDK de ningún proveedor en el código. Contrato de los eventos:
[`packages/contracts/asyncapi/events.yaml`](../../packages/contracts/asyncapi/events.yaml).

| Evento                             | Correo                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| `VerificacionEmailSolicitada`      | Confirma tu correo (enlace de verificación)                       |
| `RecuperacionContrasenaSolicitada` | Restablece tu contraseña                                          |
| `OrdenConfirmada`                  | Compra confirmada: detalle, fechas, recinto y total               |
| `EntradasEmitidas`                 | Tus entradas, con el **QR embebido** (PNG `cid:`) y código manual |
| `OrdenCancelada`                   | Pago rechazado, reserva vencida, compra anulada o reembolso       |

| Tema               | Implementación                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Topología          | Igual que `@shared/commons`: cola quorum `notifications.emails`, DLX `ticketera.dead-letter`, DLQ `notifications.emails.dlq`             |
| Idempotencia       | Entrega al-menos-una-vez: se marca `notifications:sent:<eventId>` en Redis tras enviar; `Message-ID` = id del evento                     |
| Reintentos         | Fallas transitorias (SMTP caído, 4xx, timeout, tickets no disponible): backoff exponencial con jitter, `MAX_ATTEMPTS` (8) y luego DLQ    |
| Fallas permanentes | Destinatario rechazado (5xx), dirección inválida, evento incompleto o JSON inválido: directo a la DLQ                                    |
| Seguridad          | Plantillas Jinja2 con autoescape; solo se enlaza a `PUBLIC_WEB_URL`; validación de destinatario (sin CR/LF); logs con correo enmascarado |
| Entradas           | Lee las entradas con su QR desde `tickets` (`GET /internal/orders/:id/tickets`, `x-internal-token`); omite las anuladas                  |
| Salud              | `GET /health/live`, `GET /health/ready` (RabbitMQ + Redis); apaga limpio con `SIGTERM`                                                   |

## Configurar un proveedor real

Solo variables de entorno; la API key va como contraseña SMTP. El remitente (`MAIL_FROM`) debe ser un
dominio verificado en el proveedor (SPF/DKIM).

| Proveedor  | `SMTP_HOST`                         | `SMTP_PORT` / `SMTP_SECURITY` | `SMTP_USERNAME`         | `SMTP_PASSWORD` |
| ---------- | ----------------------------------- | ----------------------------- | ----------------------- | --------------- |
| SendGrid   | `smtp.sendgrid.net`                 | `587` / `starttls`            | `apikey`                | API key         |
| Resend     | `smtp.resend.com`                   | `465` / `tls`                 | `resend`                | API key         |
| Brevo      | `smtp-relay.brevo.com`              | `587` / `starttls`            | login SMTP de la cuenta | clave SMTP      |
| Postmark   | `smtp.postmarkapp.com`              | `587` / `starttls`            | server token            | server token    |
| Mailgun    | `smtp.mailgun.org`                  | `587` / `starttls`            | `postmaster@<dominio>`  | contraseña SMTP |
| Amazon SES | `email-smtp.<región>.amazonaws.com` | `587` / `starttls`            | SMTP user               | SMTP password   |

Con docker compose basta con exportarlas (o ponerlas en `infra/.env`, que no se sube):

```bash
SMTP_HOST=smtp.sendgrid.net SMTP_PORT=587 SMTP_SECURITY=starttls SMTP_USERNAME=apikey \
SMTP_PASSWORD=<api-key> MAIL_FROM="Ticketera <no-responder@midominio.cl>" \
  docker compose -f infra/docker-compose.yml up -d notifications
```

## Desarrollo

```bash
cd services/notifications
uv sync                       # crea .venv con Python 3.12
uv run ruff check src tests && uv run ruff format --check src tests
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 \
TEST_AMQP_URL=amqp://ticketera:rabbitmq-dev-password@127.0.0.1:5672 \
  uv run pytest -q              # sin las variables se omiten las pruebas contra RabbitMQ/Redis
cp .env.example .env && uv run python -m notifications.main
```

Los correos de desarrollo se ven en Mailpit: <http://localhost:8025>.
