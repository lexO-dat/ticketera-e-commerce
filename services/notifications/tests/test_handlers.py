"""Qué correo sale de cada evento: destinatario, asunto, contenido, enlaces y QR."""

import pytest

from conftest import event
from notifications.handlers import Context, build_email
from notifications.mailer import PermanentMailError
from notifications.render import clp, when

TICKETS = [
    {
        "code": "6CVZ2EHAZ81R",
        "name": "Lumen Tour 2026 — VIP Frontal",
        "startsAt": "2026-12-11T00:00:00.000Z",
        "venueName": "Arena Central",
        "seatLabel": "Fila A · Butaca 4",
        "status": "ISSUED",
        "qr": "eyJhbGciOiJFZERTQSJ9.eyJ0aWQiOiJ4In0.firma",
    },
    {
        "code": "KBEE8MZQKSWE",
        "name": "Lumen Tour 2026 — VIP Frontal",
        "startsAt": "2026-12-11T00:00:00.000Z",
        "venueName": "Arena Central",
        "seatLabel": "Fila A · Butaca 5",
        "status": "VOIDED",
    },
]


@pytest.fixture
def ctx(settings):
    async def fetch(order_id: str):
        return TICKETS

    return Context(settings=settings, fetch_tickets=fetch)


def test_formatos_chilenos():
    assert clp("319000") == "$319.000"
    assert clp(None) == ""
    # 00:00 UTC del 11 de diciembre = 21:00 del 10 en Chile (verano, UTC-3).
    assert when("2026-12-11T00:00:00.000Z") == "jue 10 dic 2026 · 21:00"
    assert when("no es fecha") is None


async def test_verificacion_de_correo(ctx):
    url = "https://localhost:8443/verificar-email?token=abc"
    email = await build_email(
        event(
            "VerificacionEmailSolicitada",
            {"userId": "u", "email": "ana@acceptme.com", "verificationUrl": url},
        ),
        ctx,
    )
    assert email is not None
    assert email.to == "ana@acceptme.com"
    assert "Confirma tu correo" in email.subject
    assert url in email.text and f'href="{url}"' in email.html


async def test_enlaces_fuera_de_la_web_propia_se_rechazan(ctx):
    with pytest.raises(PermanentMailError):
        await build_email(
            event(
                "RecuperacionContrasenaSolicitada",
                {"email": "a@b.cl", "resetUrl": "https://phishing.example/reset"},
            ),
            ctx,
        )


async def test_campos_obligatorios(ctx):
    with pytest.raises(PermanentMailError):
        await build_email(event("RecuperacionContrasenaSolicitada", {"email": "a@b.cl"}), ctx)


async def test_compra_confirmada_con_lineas_y_total(ctx):
    email = await build_email(
        event(
            "OrdenConfirmada",
            {
                "orderId": "o1",
                "orderCode": "TK-68D1PYFY",
                "userId": "u",
                "total": "319000",
                "buyerName": "Ana <script>alert(1)</script>",
                "buyerEmail": "ana@acceptme.com",
                "lines": [
                    {
                        "name": "Lumen Tour 2026 — VIP Frontal",
                        "quantity": 2,
                        "attributes": {
                            "startsAt": "2026-12-11T00:00:00.000Z",
                            "venueName": "Arena Central",
                        },
                    }
                ],
            },
        ),
        ctx,
    )
    assert email is not None
    assert email.subject == "Compra confirmada · TK-68D1PYFY"
    assert "$319.000" in email.html and "Arena Central" in email.text
    assert "https://localhost:8443/orden/TK-68D1PYFY" in email.html
    # Datos del comprador escapados en el HTML.
    assert "<script>" not in email.html and "&lt;script&gt;" in email.html


async def test_entradas_con_qr_embebido_y_sin_las_anuladas(ctx):
    email = await build_email(
        event(
            "EntradasEmitidas",
            {
                "orderId": "o1",
                "orderCode": "TK-68D1PYFY",
                "buyerName": "Ana",
                "buyerEmail": "ana@acceptme.com",
                "ticketIds": ["t1", "t2"],
            },
        ),
        ctx,
    )
    assert email is not None
    assert len(email.images) == 1
    assert email.images[0].content.startswith(b"\x89PNG")
    assert 'src="cid:qr-6CVZ2EHAZ81R"' in email.html
    assert "KBEE8MZQKSWE" not in email.html  # anulada
    assert "Fila A · Butaca 4" in email.text


@pytest.mark.parametrize(
    ("reason", "title"),
    [
        ("REFUNDED", "Reembolso realizado"),
        ("PAYMENT_ISSUER_REJECTED", "Tu pago no se completó"),
        ("PAYMENT_CANCELED", "Compra anulada"),
        ("EXPIRED", "Tu reserva venció"),
    ],
)
async def test_orden_cancelada_segun_motivo(ctx, reason, title):
    email = await build_email(
        event(
            "OrdenCancelada",
            {
                "orderId": "o1",
                "reason": reason,
                "orderCode": "TK-1",
                "buyerName": "Ana",
                "buyerEmail": "ana@acceptme.com",
                "total": "1000",
            },
        ),
        ctx,
    )
    assert email is not None and email.subject.startswith(title)


async def test_eventos_sin_correo(ctx):
    assert (
        await build_email(event("OrdenCancelada", {"orderId": "o1", "reason": "REFUNDED"}), ctx)
        is None
    )
    assert await build_email(event("ReservaCreada", {}), ctx) is None
