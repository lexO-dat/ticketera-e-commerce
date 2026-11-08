"""Consumidor contra RabbitMQ y Redis reales (TEST_AMQP_URL, TEST_REDIS_URL): un correo por evento
aunque llegue repetido, reintentos ante fallas transitorias y DLQ ante fallas permanentes."""

import asyncio
import json
import os
import uuid

import aio_pika
import pytest
from redis.asyncio import Redis

from conftest import event
from notifications.consumer import EVENTS_EXCHANGE, Deduper, EmailConsumer
from notifications.mailer import Email, Mailer, PermanentMailError, TransientMailError

AMQP = os.environ.get("TEST_AMQP_URL")
REDIS = os.environ.get("TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    not (AMQP and REDIS), reason="requiere TEST_AMQP_URL y TEST_REDIS_URL"
)


class FlakyMailer(Mailer):
    """Falla las primeras `fail_first` veces; rechaza a `@malo.test` para siempre."""

    def __init__(self, fail_first: int = 0) -> None:
        self.sent: list[Email] = []
        self.calls = 0
        self.fail_first = fail_first

    async def send(self, email: Email) -> None:
        self.calls += 1
        if email.to.endswith("@malo.test"):
            raise PermanentMailError("rechazado")
        if self.calls <= self.fail_first:
            raise TransientMailError("SMTP caído")
        self.sent.append(email)


async def build(evt: dict) -> Email | None:
    data = evt["data"]
    if evt["type"] != "PruebaCorreo":
        return None
    return Email(
        to=data["to"], subject="hola", text="t", html="<p>t</p>", idempotency_key=evt["id"]
    )


async def wait_for(predicate, limit: float = 15.0) -> None:
    deadline = asyncio.get_running_loop().time() + limit
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("tiempo agotado")
        await asyncio.sleep(0.05)


@pytest.fixture
async def setup():
    suffix = uuid.uuid4().hex[:8]
    queue = f"notifications-test.{suffix}"
    routing = f"test.PruebaCorreo{suffix}.v1"
    redis = Redis.from_url(REDIS)
    connection = await aio_pika.connect_robust(AMQP)
    channel = await connection.channel()
    exchange = await channel.declare_exchange(
        EVENTS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )

    async def publish(evt: dict, raw: bytes | None = None) -> None:
        await exchange.publish(
            aio_pika.Message(body=raw or json.dumps(evt).encode()), routing_key=routing
        )

    consumers: list[EmailConsumer] = []

    async def start(mailer: Mailer) -> EmailConsumer:
        consumer = EmailConsumer(
            amqp_url=AMQP,
            queue=queue,
            bindings=[routing],
            build=build,
            mailer=mailer,
            deduper=Deduper(redis, 600),
            max_attempts=3,
        )
        await consumer.start()
        consumers.append(consumer)
        return consumer

    yield {"publish": publish, "start": start, "channel": channel, "queue": queue}

    for consumer in consumers:
        await consumer.close()
    await channel.queue_delete(queue)
    await channel.queue_delete(f"{queue}.dlq")
    await connection.close()
    await redis.aclose()


async def drain_dlq(channel, queue: str, expected: int, limit: float = 20.0) -> list[bytes]:
    """Lee la DLQ hasta encontrar `expected` mensajes (o agotar el tiempo)."""
    dlq = await channel.declare_queue(f"{queue}.dlq", passive=True)
    bodies: list[bytes] = []
    deadline = asyncio.get_running_loop().time() + limit
    while len(bodies) < expected and asyncio.get_running_loop().time() < deadline:
        message = await dlq.get(fail=False)
        if message is None:
            await asyncio.sleep(0.1)
            continue
        bodies.append(message.body)
        await message.ack()
    return bodies


async def test_un_correo_por_evento_aunque_llegue_repetido(setup):
    mailer = FlakyMailer()
    await setup["start"](mailer)
    evt = event("PruebaCorreo", {"to": "ana@acceptme.com"})
    for _ in range(3):
        await setup["publish"](evt)
    await setup["publish"](event("OtroEvento", {}))
    await wait_for(lambda: len(mailer.sent) == 1)
    await asyncio.sleep(0.5)
    assert len(mailer.sent) == 1
    assert mailer.sent[0].idempotency_key == evt["id"]


async def test_reintenta_fallas_transitorias(setup):
    mailer = FlakyMailer(fail_first=2)
    await setup["start"](mailer)
    await setup["publish"](event("PruebaCorreo", {"to": "ana@acceptme.com"}))
    await wait_for(lambda: len(mailer.sent) == 1)
    assert mailer.calls == 3


async def test_fallas_permanentes_y_eventos_invalidos_van_a_la_dlq(setup):
    mailer = FlakyMailer()
    await setup["start"](mailer)
    await setup["publish"](event("PruebaCorreo", {"to": "x@malo.test"}))
    await setup["publish"]({}, raw=b"no es json")
    await wait_for(lambda: mailer.calls == 1)

    dead = await drain_dlq(setup["channel"], setup["queue"], 2)
    assert len(dead) == 2
    assert b"no es json" in dead
    assert mailer.sent == []


async def test_agota_los_reintentos_y_va_a_la_dlq(setup):
    mailer = FlakyMailer(fail_first=100)
    await setup["start"](mailer)
    await setup["publish"](event("PruebaCorreo", {"to": "ana@acceptme.com"}))
    assert len(await drain_dlq(setup["channel"], setup["queue"], 1)) == 1
    assert mailer.calls == 3  # max_attempts


async def test_reserva_atomica_un_solo_envio_con_copias_simultaneas():
    redis = Redis.from_url(REDIS)
    deduper = Deduper(redis, 600)
    event_id = str(uuid.uuid4())
    try:
        claims = await asyncio.gather(*(deduper.claim(event_id) for _ in range(20)))
        assert claims.count(True) == 1
        # Falla transitoria: se libera y el reintento puede reservarlo; tras enviar, nadie más.
        await deduper.release(event_id)
        assert await deduper.claim(event_id)
        await deduper.mark(event_id)
        assert not await deduper.claim(event_id)
    finally:
        await redis.delete(Deduper.key(event_id))
        await redis.aclose()
