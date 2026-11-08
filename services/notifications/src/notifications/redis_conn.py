"""Conexión a Redis: directa o vía Sentinel (ADR-01), con la misma URL que los servicios Node:
`redis://:clave@redis-primary:6379?sentinels=host:puerto,...&master=nombre`."""

from urllib.parse import parse_qs, unquote, urlsplit

from redis.asyncio import Redis
from redis.asyncio.sentinel import Sentinel


def sentinel_settings(url: str) -> dict | None:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    if "sentinels" not in query:
        return None
    hosts = []
    for entry in query["sentinels"][0].split(","):
        host, _, port = entry.strip().partition(":")
        hosts.append((host, int(port or 26379)))
    return {
        "sentinels": hosts,
        "master": query.get("master", ["ticketera"])[0],
        "password": unquote(parts.password) if parts.password else None,
        "db": int(parts.path.lstrip("/") or 0),
    }


def connect_redis(url: str) -> Redis:
    config = sentinel_settings(url)
    if config is None:
        return Redis.from_url(url)
    # Los Sentinel indican el primario actual; tras un failover el cliente se reconecta al nuevo.
    sentinel = Sentinel(
        config["sentinels"],
        socket_timeout=2,
        password=config["password"],
        db=config["db"],
    )
    return sentinel.master_for(config["master"], socket_timeout=2)
