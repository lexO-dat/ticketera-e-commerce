import os
import uuid

import pytest

from notifications.config import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        amqp_url=os.environ.get("TEST_AMQP_URL", "amqp://guest:guest@localhost:5672"),
        redis_url=os.environ.get("TEST_REDIS_URL", "redis://localhost:6379"),
        internal_api_token="internal-test-token-0123456789abcdef",
        public_web_url="https://localhost:8443/",
        mail_from="Ticketera <no-responder@ticketera.test>",
        smtp_host="127.0.0.1",
        smtp_port=2525,
    )


def event(kind: str, data: dict) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": kind,
        "version": 1,
        "source": "test",
        "occurredAt": "2026-11-08T12:00:00.000Z",
        "aggregateId": "agg",
        "data": data,
    }
