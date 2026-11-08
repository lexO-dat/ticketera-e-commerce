"""Consumidor de RabbitMQ con la misma topología y reintentos que `@shared/commons` (events):
exchange de tópicos `ticketera.events`, cola quorum con DLX `ticketera.dead-letter` y DLQ
`<cola>.dlq`, reintentos explícitos con la cabecera `x-retry-count` y backoff con jitter."""

import asyncio
import json
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustChannel, AbstractRobustConnection

from .logs import mask_email
from .mailer import Email, Mailer, PermanentMailError

log = logging.getLogger("notifications.consumer")

EVENTS_EXCHANGE = "ticketera.events"
DEAD_LETTER_EXCHANGE = "ticketera.dead-letter"
RETRY_HEADER = "x-retry-count"
#: Red de seguridad para mensajes que botan el proceso (igual que commons).
POISON_DELIVERY_LIMIT = 20

EmailBuilder = Callable[[dict[str, Any]], Awaitable[Email | None]]


class Deduper:
    """Evita reenviar el correo de un evento ya procesado (entrega al-menos-una-vez)."""

    def __init__(self, redis: Any, ttl_seconds: int) -> None:
        self.redis = redis
        self.ttl = ttl_seconds

    @staticmethod
    def key(event_id: str) -> str:
        return f"notifications:sent:{event_id}"

    async def seen(self, event_id: str) -> bool:
        return bool(await self.redis.exists(self.key(event_id)))

    async def mark(self, event_id: str) -> None:
        await self.redis.set(self.key(event_id), "1", ex=self.ttl)


def backoff_seconds(attempt: int, base: float = 0.2, cap: float = 10.0) -> float:
    """Backoff exponencial con full jitter (como `backoffDelay` de commons)."""
    return random.uniform(0, min(cap, base * 2 ** max(0, attempt - 1)))  # noqa: S311


class EmailConsumer:
    def __init__(
        self,
        *,
        amqp_url: str,
        queue: str,
        bindings: list[str],
        build: EmailBuilder,
        mailer: Mailer,
        deduper: Deduper,
        max_attempts: int,
        prefetch: int = 10,
    ) -> None:
        self.amqp_url = amqp_url
        self.queue_name = queue
        self.bindings = bindings
        self.build = build
        self.mailer = mailer
        self.deduper = deduper
        self.max_attempts = max_attempts
        self.prefetch = prefetch
        self.connection: AbstractRobustConnection | None = None
        self.channel: AbstractRobustChannel | None = None

    @property
    def connected(self) -> bool:
        return self.connection is not None and not self.connection.is_closed

    async def start(self) -> None:
        # Conexión robusta: reconecta y vuelve a declarar la topología si el broker cae.
        self.connection = await aio_pika.connect_robust(
            self.amqp_url, client_properties={"connection_name": "notifications"}
        )
        self.channel = await self.connection.channel()
        await self.channel.set_qos(prefetch_count=self.prefetch)
        events = await self.channel.declare_exchange(
            EVENTS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
        )
        dead = await self.channel.declare_exchange(
            DEAD_LETTER_EXCHANGE, aio_pika.ExchangeType.DIRECT, durable=True
        )
        dlq = await self.channel.declare_queue(
            f"{self.queue_name}.dlq", durable=True, arguments={"x-queue-type": "quorum"}
        )
        await dlq.bind(dead, routing_key=self.queue_name)
        queue = await self.channel.declare_queue(
            self.queue_name,
            durable=True,
            arguments={
                "x-queue-type": "quorum",
                "x-delivery-limit": POISON_DELIVERY_LIMIT,
                "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
                "x-dead-letter-routing-key": self.queue_name,
            },
        )
        for pattern in self.bindings:
            await queue.bind(events, routing_key=pattern)
        await queue.consume(self.handle)
        log.info("consumiendo eventos", extra={"queue": self.queue_name})

    async def close(self) -> None:
        if self.connection:
            await self.connection.close()

    async def handle(self, message: AbstractIncomingMessage) -> None:
        try:
            event = json.loads(message.body)
            event_id = str(event["id"])
            event_type = str(event["type"])
        except (ValueError, KeyError, TypeError):
            log.error("evento inválido: se envía a la DLQ", extra={"messageId": message.message_id})
            await message.reject(requeue=False)
            return

        context = {"eventId": event_id, "eventType": event_type}
        try:
            if await self.deduper.seen(event_id):
                await message.ack()
                return
            email = await self.build(event)
            if email is not None:
                await self.mailer.send(email)
                await self.deduper.mark(event_id)
                log.info("notificación enviada", extra={**context, "to": mask_email(email.to)})
            await message.ack()
        except PermanentMailError as error:
            # Reintentar no lo arregla (correo inválido, rechazo definitivo): a la DLQ.
            log.error("correo no enviable: DLQ", extra={**context, "reason": str(error)})
            await message.reject(requeue=False)
        except Exception as error:
            await self._retry(message, context, error)

    async def _retry(
        self, message: AbstractIncomingMessage, context: dict[str, str], error: Exception
    ) -> None:
        attempt = int((message.headers or {}).get(RETRY_HEADER, 0) or 0) + 1
        if attempt >= self.max_attempts:
            log.error(
                "evento agotó sus reintentos: DLQ",
                extra={**context, "attempt": attempt, "err": repr(error)},
            )
            await message.reject(requeue=False)
            return
        log.warning(
            "fallo al notificar, se reintenta",
            extra={**context, "attempt": attempt, "err": repr(error)},
        )
        await asyncio.sleep(backoff_seconds(attempt))
        try:
            # Copia con el contador al final de la cola y luego ack del original (idempotente).
            assert self.channel is not None
            await self.channel.default_exchange.publish(
                aio_pika.Message(
                    body=message.body,
                    headers={**(message.headers or {}), RETRY_HEADER: attempt},
                    content_type=message.content_type or "application/json",
                    message_id=message.message_id,
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                ),
                routing_key=self.queue_name,
            )
            await message.ack()
        except Exception:
            # Sin broker: se devuelve tal cual y se reentrega al reconectar.
            await message.nack(requeue=True)
