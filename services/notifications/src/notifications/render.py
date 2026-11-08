"""Plantillas Jinja2 (HTML con autoescape + texto plano) y formatos chilenos."""

from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

TEMPLATES = Path(__file__).parent / "templates"
CHILE = ZoneInfo("America/Santiago")

_html = Environment(
    loader=FileSystemLoader(TEMPLATES),
    autoescape=select_autoescape(["html"]),
    undefined=StrictUndefined,
)
# Texto plano: sin escape HTML (no se interpreta), pero con variables obligatorias igual.
_text = Environment(
    loader=FileSystemLoader(TEMPLATES),
    autoescape=False,  # noqa: S701 - plantillas .txt, nunca se muestran como HTML
    undefined=StrictUndefined,
    keep_trailing_newline=True,
)


def render(name: str, /, **context: Any) -> tuple[str, str]:
    """Devuelve (texto, html) de la plantilla `name`."""
    text = _text.get_template(f"{name}.txt").render(**context)
    html = _html.get_template(f"{name}.html").render(**context)
    return text, html


def clp(amount: str | int | None) -> str:
    """`319000` → `$319.000` (CLP sin decimales)."""
    if amount is None or amount == "":
        return ""
    return "$" + f"{int(amount):,}".replace(",", ".")


def when(iso: str | None) -> str | None:
    """Fecha y hora de la función en hora de Chile: `vie 10 dic 2026 · 21:00`."""
    if not iso:
        return None
    try:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(CHILE)
    except ValueError:
        return None
    days = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"]
    return (
        f"{days[moment.weekday()]} {moment.day} {months[moment.month - 1]} {moment.year}"
        f" · {moment:%H:%M}"
    )
