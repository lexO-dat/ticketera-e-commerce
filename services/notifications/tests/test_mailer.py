"""Envío SMTP real contra un servidor local (aiosmtpd): formato del mensaje y errores."""

from email import message_from_bytes, policy

import pytest
from aiosmtpd.controller import Controller

from notifications.mailer import (
    Email,
    InlineImage,
    PermanentMailError,
    SmtpMailer,
    TransientMailError,
)


class Inbox:
    def __init__(self) -> None:
        self.messages: list[bytes] = []
        self.envelopes: list[tuple[str, list[str]]] = []

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        if address.endswith("@rechazado.test"):
            return "550 5.1.1 buzón inexistente"
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        self.messages.append(envelope.content)
        self.envelopes.append((envelope.mail_from, list(envelope.rcpt_tos)))
        return "250 OK"


@pytest.fixture
def smtp():
    inbox = Inbox()
    controller = Controller(inbox, hostname="127.0.0.1", port=2525)
    controller.start()
    yield inbox
    controller.stop()


def sample(to: str = "ana@acceptme.com") -> Email:
    return Email(
        to=to,
        subject="Tus entradas · TK-1",
        text="Texto plano",
        html='<p>HTML <img src="cid:qr-1"></p>',
        idempotency_key="1f0e2d3c-0000-4000-8000-000000000001",
        images=[InlineImage(cid="qr-1", content=b"\x89PNG\r\n\x1a\nfalso")],
    )


async def test_envia_multiparte_con_imagen_embebida(settings, smtp):
    await SmtpMailer(settings).send(sample())
    assert smtp.envelopes == [("no-responder@ticketera.test", ["ana@acceptme.com"])]
    message = message_from_bytes(smtp.messages[0], policy=policy.default)
    assert message["Subject"] == "Tus entradas · TK-1"
    assert message["Message-ID"] == "<1f0e2d3c-0000-4000-8000-000000000001@ticketera.test>"
    assert message["Auto-Submitted"] == "auto-generated"
    assert message.get_body(preferencelist=("plain",)).get_content().strip() == "Texto plano"
    image = next(part for part in message.walk() if part.get_content_type() == "image/png")
    assert image["Content-ID"] == "<qr-1>"


async def test_destinatario_rechazado_es_permanente(settings, smtp):
    with pytest.raises(PermanentMailError):
        await SmtpMailer(settings).send(sample("nadie@rechazado.test"))


async def test_direccion_invalida_o_con_saltos_es_permanente(settings, smtp):
    for bad in ("sin-arroba", "a@b.cl\r\nBcc: victima@x.cl"):
        with pytest.raises(PermanentMailError):
            await SmtpMailer(settings).send(sample(bad))
    assert smtp.messages == []


async def test_servidor_caido_es_transitorio(settings):
    settings.smtp_port = 1  # nada escucha ahí
    settings.smtp_timeout_seconds = 2
    with pytest.raises(TransientMailError):
        await SmtpMailer(settings).send(sample())


def test_variables_vacias_no_activan_autenticacion(monkeypatch):
    from notifications.config import Settings

    monkeypatch.setenv("SMTP_USERNAME", "")
    monkeypatch.setenv("SMTP_PASSWORD", "")
    monkeypatch.setenv("MAIL_REPLY_TO", " ")
    config = Settings(amqp_url="amqp://x", redis_url="redis://x", internal_api_token="t")
    assert config.smtp_username is None
    assert config.smtp_password is None
    assert config.mail_reply_to is None


def test_redis_por_sentinel():
    from notifications.redis_conn import sentinel_settings

    assert sentinel_settings("redis://:clave@redis-primary:6379") is None
    assert sentinel_settings(
        "redis://:cl%40ve@redis-primary:6379/1?sentinels=s1:26379,s2&master=ticketera"
    ) == {
        "sentinels": [("s1", 26379), ("s2", 26379)],
        "master": "ticketera",
        "password": "cl@ve",
        "db": 1,
    }
