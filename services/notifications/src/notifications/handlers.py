"""Qué correo corresponde a cada evento de dominio (contrato: packages/contracts/asyncapi)."""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Any

import segno

from .config import Settings
from .mailer import Email, InlineImage, PermanentMailError
from .render import clp, render, when

log = logging.getLogger("notifications.handlers")

#: Eventos que consume el servicio (patrones de enrutamiento `<source>.<Tipo>.*`).
BINDINGS = [
    "identity.VerificacionEmailSolicitada.*",
    "identity.RecuperacionContrasenaSolicitada.*",
    "orders.OrdenConfirmada.*",
    "orders.OrdenCancelada.*",
    "tickets.EntradasEmitidas.*",
]

TicketsFetcher = Callable[[str], Awaitable[list[dict[str, Any]]]]


@dataclass
class Context:
    settings: Settings
    fetch_tickets: TicketsFetcher


def _require(data: dict[str, Any], *keys: str) -> None:
    missing = [key for key in keys if not data.get(key)]
    if missing:
        # Evento mal formado: reintentar no lo arregla.
        raise PermanentMailError(f"faltan campos: {', '.join(missing)}")


def _own_link(settings: Settings, url: str) -> str:
    """Solo se envían enlaces a la web propia (un evento adulterado no puede mandar phishing)."""
    if not url.startswith(settings.public_web_url + "/"):
        raise PermanentMailError("enlace fuera de PUBLIC_WEB_URL")
    return url


def _order_url(settings: Settings, code: str) -> str:
    return f"{settings.public_web_url}/orden/{code}"


def _email(
    event: dict[str, Any],
    to: str,
    subject: str,
    template: str,
    *,
    images: list[InlineImage] | None = None,
    **ctx: Any,
) -> Email:
    text, html = render(template, subject=subject, **{"preheader": subject, **ctx})
    return Email(
        to=to,
        subject=subject,
        text=text,
        html=html,
        idempotency_key=event["id"],
        images=images or [],
    )


async def build_email(event: dict[str, Any], ctx: Context) -> Email | None:
    """El correo para `event`, o `None` si el evento no genera correo."""
    kind = event.get("type")
    data: dict[str, Any] = event.get("data") or {}
    settings = ctx.settings

    if kind == "VerificacionEmailSolicitada":
        _require(data, "email", "verificationUrl")
        return _email(
            event,
            data["email"],
            "Confirma tu correo en Ticketera",
            "verify_email",
            url=_own_link(settings, data["verificationUrl"]),
            name=data.get("fullName"),
            preheader="Un clic para activar tu cuenta.",
        )

    if kind == "RecuperacionContrasenaSolicitada":
        _require(data, "email", "resetUrl")
        return _email(
            event,
            data["email"],
            "Restablece tu contraseña de Ticketera",
            "reset_password",
            url=_own_link(settings, data["resetUrl"]),
            preheader="El enlace vence en 1 hora.",
        )

    if kind == "OrdenConfirmada":
        _require(data, "buyerEmail", "orderCode")
        lines = []
        for line in data.get("lines", []):
            attributes = line.get("attributes") or {}
            details = " · ".join(
                part
                for part in (when(attributes.get("startsAt")), attributes.get("venueName"))
                if part
            )
            lines.append(
                {"name": line["name"], "quantity": line["quantity"], "details": details or None}
            )
        return _email(
            event,
            data["buyerEmail"],
            f"Compra confirmada · {data['orderCode']}",
            "order_confirmed",
            name=data.get("buyerName") or "",
            order_code=data["orderCode"],
            lines=lines,
            total=clp(data.get("total")),
            order_url=_order_url(settings, data["orderCode"]),
            preheader=f"Pago aprobado por {clp(data.get('total'))}.",
        )

    if kind == "EntradasEmitidas":
        _require(data, "orderId", "orderCode", "buyerEmail")
        tickets = await ctx.fetch_tickets(data["orderId"])
        images: list[InlineImage] = []
        rows = []
        for ticket in tickets:
            if ticket.get("status") == "VOIDED":
                continue
            cid = None
            if ticket.get("qr"):
                cid = f"qr-{ticket['code']}"
                images.append(InlineImage(cid=cid, content=_qr_png(ticket["qr"])))
            rows.append(
                {
                    "cid": cid,
                    "code": ticket["code"],
                    "name": ticket["name"],
                    "when": when(ticket.get("startsAt")),
                    "venue": ticket.get("venueName"),
                    "seat": ticket.get("seatLabel"),
                }
            )
        if not rows:
            return None
        return _email(
            event,
            data["buyerEmail"],
            f"Tus entradas · {data['orderCode']}",
            "tickets_issued",
            images=images,
            name=data.get("buyerName") or "",
            order_code=data["orderCode"],
            tickets=rows,
            order_url=_order_url(settings, data["orderCode"]),
            preheader=f"{len(rows)} entrada(s) con código QR.",
        )

    if kind == "OrdenCancelada":
        if not data.get("buyerEmail") or not data.get("orderCode"):
            return None  # eventos anteriores a la Fase 7 no traen el contacto
        title, message = _cancellation_copy(str(data.get("reason", "")))
        return _email(
            event,
            data["buyerEmail"],
            f"{title} · {data['orderCode']}",
            "order_cancelled",
            title=title,
            message=message,
            name=data.get("buyerName") or "",
            order_code=data["orderCode"],
            total=clp(data.get("total")),
            order_url=_order_url(settings, data["orderCode"]),
        )

    return None


def _cancellation_copy(reason: str) -> tuple[str, str]:
    if reason == "REFUNDED":
        return (
            "Reembolso realizado",
            "devolvimos el pago de tu orden al medio de pago que usaste. Las entradas que no se "
            "usaron quedaron anuladas. El abono puede tardar unos días según tu banco.",
        )
    if reason in ("EXPIRED", "PAYMENT_EXPIRED", "PAYMENT_FORM_TIMEOUT"):
        return (
            "Tu reserva venció",
            "el tiempo para pagar terminó y liberamos las entradas. No se hizo ningún cobro.",
        )
    if reason == "PAYMENT_CANCELED":
        return (
            "Compra anulada",
            "anulaste el pago, así que liberamos las entradas. No se hizo ningún cobro.",
        )
    return (
        "Tu pago no se completó",
        "el medio de pago rechazó la transacción y liberamos las entradas. No se hizo ningún "
        "cobro; puedes intentarlo de nuevo.",
    )


def _qr_png(content: str) -> bytes:
    """QR del token firmado de la entrada como PNG (corrección M, 5 px por módulo)."""
    buffer = BytesIO()
    segno.make(content, error="m").save(buffer, kind="png", scale=5, border=2)
    return buffer.getvalue()
