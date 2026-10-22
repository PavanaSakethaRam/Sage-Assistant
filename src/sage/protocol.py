"""Private bounded UTF-8 JSON framing and closed version-one envelopes."""

import asyncio
import json
from typing import Annotated, Literal, cast

from pydantic import Field, ValidationError

from sage.contracts import Contract

MAX_FRAME_BYTES = 1_048_576
RpcId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
ErrorCode = Literal[
    "invalid_frame",
    "invalid_request",
    "duplicate_id",
    "session_limit",
    "busy",
    "timeout",
    "cancelled",
    "unknown_request",
    "not_found",
    "internal_error",
    "shutting_down",
]


class ProtocolError(ValueError):
    """Invalid framing, with no caller data in diagnostics."""


class Request(Contract):
    version: Literal[1]
    id: RpcId
    kind: Literal["request"]
    method: str
    params: dict[str, object]
    timeout_ms: Annotated[int, Field(ge=1, le=30_000)] = 30_000


class Response(Contract):
    version: Literal[1] = 1
    id: RpcId
    kind: Literal["response"] = "response"
    result: dict[str, object]


class Failure(Contract):
    version: Literal[1] = 1
    id: RpcId | None
    kind: Literal["error"] = "error"
    code: ErrorCode


class Progress(Contract):
    version: Literal[1] = 1
    id: RpcId
    kind: Literal["progress"] = "progress"
    status: Literal["started"]
    task_id: RpcId


def failure(identifier: str | None, code: ErrorCode) -> dict[str, object]:
    return Failure(id=identifier, code=code).model_dump(mode="json")


def request(message: dict[str, object]) -> Request:
    try:
        # Literal[1] alone accepts True in Pydantic; wire version is a strict integer.
        if type(message.get("version")) is not int:
            raise ValueError
        return Request.model_validate(message)
    except (ValueError, ValidationError):
        raise ProtocolError("Invalid request") from None


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ProtocolError("Invalid frame")
        value[key] = item
    return value


def _constant(value: str) -> object:
    raise ProtocolError("Invalid frame")


def encode_frame(message: dict[str, object]) -> bytes:
    try:
        payload = json.dumps(
            message, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        if not 0 < len(payload) <= MAX_FRAME_BYTES:
            raise ValueError
        return len(payload).to_bytes(4, "big") + payload
    except (ValueError, TypeError, RecursionError):
        raise ProtocolError("Invalid frame") from None


async def read_frame(reader: asyncio.StreamReader) -> dict[str, object]:
    try:
        prefix = await reader.readexactly(4)
    except asyncio.IncompleteReadError as error:
        if not error.partial:
            raise EOFError from None
        raise ProtocolError("Invalid frame") from None
    length = int.from_bytes(prefix, "big")
    if not 0 < length <= MAX_FRAME_BYTES:
        raise ProtocolError("Invalid frame")
    try:
        body = await reader.readexactly(length)
        text = body.decode("utf-8")
        value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
        stack = [(value, 0)]
        while stack:
            item, depth = stack.pop()
            if depth > 32:
                raise ValueError
            children = (
                item.values() if isinstance(item, dict) else item if isinstance(item, list) else ()
            )
            stack.extend((child, depth + 1) for child in children)
        # JSON escapes must not smuggle unpaired surrogates into later output.
        json.dumps(value, ensure_ascii=False).encode("utf-8")
        if not isinstance(value, dict):
            raise ValueError
        return cast(dict[str, object], value)
    except (asyncio.IncompleteReadError, ValueError, UnicodeError, RecursionError):
        raise ProtocolError("Invalid frame") from None
