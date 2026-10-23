"""Reject hostile framing before it can reach domain authority."""

import asyncio

import pytest

from sage.protocol import ProtocolError, encode_frame, read_frame


def read(data: bytes) -> dict[str, object]:
    async def receive() -> dict[str, object]:
        reader = asyncio.StreamReader()
        reader.feed_data(data)
        reader.feed_eof()
        return await read_frame(reader)

    return asyncio.run(receive())


def raw(body: bytes) -> bytes:
    return len(body).to_bytes(4, "big") + body


def test_frame_preserves_literal_unicode_and_byte_length() -> None:
    value: dict[str, object] = {"title": "é😀", "body": "\r\n\t literal"}
    frame = encode_frame(value)
    assert int.from_bytes(frame[:4], "big") == len(frame[4:])
    assert read(frame) == value


def test_frame_exact_limit_and_excess() -> None:
    frame = encode_frame({"x": "a" * (1_048_576 - 8)})
    assert len(frame) == 1_048_580
    assert read(frame)["x"] == "a" * (1_048_576 - 8)
    with pytest.raises(ProtocolError):
        encode_frame({"x": "a" * 1_048_576})
    with pytest.raises(ProtocolError):
        read((1_048_577).to_bytes(4, "big"))


@pytest.mark.parametrize(
    "frame",
    [b"\x00", b"\x00\x00\x00", b"\x00\x00\x00\x04{}", b"\0\0\0\0"]
    + [
        raw(body)
        for body in [
            b"\xff",
            b"{",
            b"[]",
            b"null",
            b'{"x":1,"x":2}',
            b'{"x":NaN}',
            b'{"x":Infinity}',
            b'{"x":"\\ud800"}',
        ]
    ],
)
def test_malformed_frames_fail_closed(frame: bytes) -> None:
    with pytest.raises(ProtocolError):
        read(frame)


def test_clean_eof_is_distinct_from_truncated_prefix() -> None:
    with pytest.raises(EOFError):
        read(b"")


def test_fragmented_and_consecutive_frames() -> None:
    async def fragmented() -> None:
        reader = asyncio.StreamReader()
        frame = encode_frame({"a": 1}) + encode_frame({"b": 2})
        for byte in frame:
            reader.feed_data(bytes([byte]))
            await asyncio.sleep(0)
        assert await read_frame(reader) == {"a": 1}
        assert await read_frame(reader) == {"b": 2}

    asyncio.run(fragmented())


@pytest.mark.parametrize("value", [{"x": float("nan")}, {"x": object()}, {"x": "\ud800"}])
def test_unencodable_response_is_safe(value: dict[str, object]) -> None:
    with pytest.raises(ProtocolError, match="Invalid frame"):
        encode_frame(value)


def test_excessive_json_nesting_is_safe() -> None:
    with pytest.raises(ProtocolError):
        read(raw(b'{"x":' + b"[" * 2000 + b"0" + b"]" * 2000 + b"}"))
