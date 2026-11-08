"""Entradas de una orden (con su QR) desde el endpoint interno de `tickets`."""

from typing import Any

import aiohttp

from .config import Settings


class TicketsClient:
    def __init__(self, settings: Settings) -> None:
        self.base_url = settings.tickets_url.rstrip("/")
        self.token = settings.internal_api_token.get_secret_value()
        self.session: aiohttp.ClientSession | None = None

    async def fetch(self, order_id: str) -> list[dict[str, Any]]:
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))
        async with self.session.get(
            f"{self.base_url}/internal/orders/{order_id}/tickets",
            headers={"x-internal-token": self.token, "accept": "application/json"},
        ) as response:
            # Un error aquí es transitorio: el consumidor reintenta con backoff.
            response.raise_for_status()
            body = await response.json()
            return list(body.get("items", []))

    async def close(self) -> None:
        if self.session:
            await self.session.close()
