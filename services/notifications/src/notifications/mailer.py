"""Envío por SMTP (aiosmtplib). Funciona con Mailpit en desarrollo y con cualquier proveedor que
ofrezca SMTP en producción, sin atar el código a un SDK: basta con host, usuario y la API key como
contraseña."""

import logging
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import parseaddr

import aiosmtplib

from .config import Settings
from .logs import mask_email

log = logging.getLogger("notifications.mailer")


@dataclass(frozen=True)
class InlineImage:
    """Imagen embebida (`cid:`), p. ej. el QR de una entrada."""

    cid: str
    content: bytes
    subtype: str = "png"


@dataclass
class Email:
    to: str
    subject: str
    text: str
    html: str
    #: Id estable (del evento): un reenvío conserva el mismo Message-ID.
    idempotency_key: str
    images: list[InlineImage] = field(default_factory=list)


class PermanentMailError(Exception):
    """El correo nunca se podrá enviar (destinatario inválido o rechazado): no se reintenta."""


class TransientMailError(Exception):
    """Falla temporal (SMTP caído, 4xx, timeout): el evento se reintenta con backoff."""


class Mailer:
    async def send(self, email: Email) -> None:
        raise NotImplementedError


def build_message(email: Email, sender: str, reply_to: str | None) -> EmailMessage:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = email.to
    message["Subject"] = email.subject
    if reply_to:
        message["Reply-To"] = reply_to
    domain = parseaddr(sender)[1].partition("@")[2] or "ticketera.local"
    message["Message-ID"] = f"<{email.idempotency_key}@{domain}>"
    # Correo automático: los auto-respondedores no deben contestarlo (RFC 3834).
    message["Auto-Submitted"] = "auto-generated"
    message.set_content(email.text)
    message.add_alternative(email.html, subtype="html")
    if email.images:
        html_part = message.get_payload()[1]
        for image in email.images:
            html_part.add_related(
                image.content, maintype="image", subtype=image.subtype, cid=f"<{image.cid}>"
            )
    return message


class SmtpMailer(Mailer):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def send(self, email: Email) -> None:
        _, address = parseaddr(email.to)
        if "@" not in address or "\n" in email.to or "\r" in email.to:
            raise PermanentMailError("dirección de correo inválida")
        message = build_message(email, self.settings.mail_from, self.settings.mail_reply_to)
        password = self.settings.smtp_password
        try:
            await aiosmtplib.send(
                message,
                hostname=self.settings.smtp_host,
                port=self.settings.smtp_port,
                username=self.settings.smtp_username,
                password=password.get_secret_value() if password else None,
                use_tls=self.settings.smtp_security == "tls",
                start_tls=self.settings.smtp_security == "starttls",
                timeout=self.settings.smtp_timeout_seconds,
            )
        except aiosmtplib.SMTPRecipientsRefused as error:
            raise PermanentMailError("el servidor rechazó al destinatario") from error
        except aiosmtplib.SMTPResponseException as error:
            # 5xx: rechazo definitivo; 4xx: temporal (cuota, greylisting).
            if 500 <= error.code < 600:
                raise PermanentMailError(f"SMTP {error.code}") from error
            raise TransientMailError(f"SMTP {error.code}") from error
        except (aiosmtplib.SMTPException, OSError, TimeoutError) as error:
            raise TransientMailError(type(error).__name__) from error
        log.info("correo enviado", extra={"to": mask_email(address), "subject": email.subject})
