"""Arranque: consumidor de eventos + /health/live y /health/ready, apagado limpio con SIGTERM."""

import asyncio
import contextlib
import signal
from typing import Any

from aiohttp import web
from redis.asyncio import Redis

from .config import Settings
from .consumer import Deduper, EmailConsumer
from .handlers import BINDINGS, Context, build_email
from .logs import setup_logging
from .mailer import Email, SmtpMailer
from .redis_conn import connect_redis
from .tickets_client import TicketsClient


def health_app(consumer: EmailConsumer, redis: Redis) -> web.Application:
    app = web.Application()
    state = {"accepting": True}

    async def live(_: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    async def ready(_: web.Request) -> web.Response:
        checks: dict[str, str] = {}
        checks["rabbitmq"] = "ok" if consumer.connected else "fail"
        try:
            await asyncio.wait_for(redis.ping(), timeout=2)
            checks["redis"] = "ok"
        except Exception:
            checks["redis"] = "fail"
        healthy = state["accepting"] and all(value == "ok" for value in checks.values())
        return web.json_response(
            {"status": "ok" if healthy else "degraded", "checks": checks},
            status=200 if healthy else 503,
        )

    app.router.add_get("/health/live", live)
    app.router.add_get("/health/ready", ready)
    app["state"] = state
    return app


async def run() -> None:
    settings = Settings()  # type: ignore[call-arg]
    log = setup_logging(settings.service_name, settings.log_level)
    redis = connect_redis(settings.redis_url)
    tickets = TicketsClient(settings)
    context = Context(settings=settings, fetch_tickets=tickets.fetch)

    async def build(event: dict[str, Any]) -> Email | None:
        return await build_email(event, context)

    consumer = EmailConsumer(
        amqp_url=settings.amqp_url,
        queue=settings.queue_name,
        bindings=BINDINGS,
        build=build,
        mailer=SmtpMailer(settings),
        deduper=Deduper(redis, settings.dedupe_ttl_seconds),
        max_attempts=settings.max_attempts,
    )
    await consumer.start()

    app = health_app(consumer, redis)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", settings.port).start()  # noqa: S104 - dentro del contenedor
    log.info(
        "notifications listo",
        extra={
            "port": settings.port,
            "smtp": f"{settings.smtp_host}:{settings.smtp_port}",
            "security": settings.smtp_security,
            "auth": settings.smtp_username is not None,
        },
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):  # Windows no tiene add_signal_handler
            loop.add_signal_handler(sig, stop.set)
    await stop.wait()

    log.info("apagando: deja de aceptar y cierra conexiones")
    app["state"]["accepting"] = False
    await consumer.close()
    await tickets.close()
    await redis.aclose()
    await runner.cleanup()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
