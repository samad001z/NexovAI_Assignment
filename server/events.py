"""Tiny in-process pub/sub. Tool handlers publish, the dashboard listens over SSE."""

import asyncio
import json

_subscribers: set[asyncio.Queue] = set()
active_calls = 0  # calls in progress, shown on the staff desk


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def call_started() -> None:
    global active_calls
    active_calls += 1
    publish("call", state="connected", active=active_calls)


def call_ended() -> None:
    global active_calls
    active_calls = max(0, active_calls - 1)
    publish("call", state="ended", active=active_calls)


def publish(kind: str, **data) -> None:
    msg = json.dumps({"type": kind, **data})
    for q in list(_subscribers):
        q.put_nowait(msg)
