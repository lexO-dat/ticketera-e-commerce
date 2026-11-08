"""Configuración por variables de entorno (validada al arrancar; nunca secretos en el repo)."""

from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "notifications"
    port: int = 3000
    log_level: str = "info"

    amqp_url: str
    redis_url: str
    #: Cola durable del consumidor (quorum, con DLQ `<cola>.dlq`).
    queue_name: str = "notifications.emails"
    #: Intentos antes de mandar el evento a la DLQ (errores transitorios: SMTP caído, timeouts).
    max_attempts: int = Field(default=8, ge=1, le=50)

    #: SMTP propio o de cualquier proveedor. En producción: host del proveedor, usuario y la API
    #: key como contraseña (SendGrid: usuario `apikey`; Resend: `resend`; Brevo: el login SMTP).
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    #: `none` solo para Mailpit en desarrollo; `starttls` (587) o `tls` (465) en producción.
    smtp_security: Literal["none", "starttls", "tls"] = "none"
    smtp_timeout_seconds: float = 15.0

    mail_from: str = "Ticketera <no-responder@ticketera.local>"
    mail_reply_to: str | None = None
    public_web_url: str = "https://localhost:8443"

    #: Servicio tickets (endpoint interno) para adjuntar las entradas con su QR.
    tickets_url: str = "http://tickets:3000"
    internal_api_token: SecretStr

    #: Evita reenviar el mismo correo si el evento llega repetido (al-menos-una-vez).
    dedupe_ttl_seconds: int = 30 * 24 * 3600

    @field_validator("public_web_url")
    @classmethod
    def strip_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("smtp_username", "mail_reply_to")
    @classmethod
    def blank_is_none(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("smtp_password")
    @classmethod
    def empty_is_none(cls, value: SecretStr | None) -> SecretStr | None:
        return value if value and value.get_secret_value() else None
