"""Network/runtime boundary double; synthetic artifacts exercise Sage's cleanup."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any


class FakeSdk:
    def __init__(self) -> None:
        self.client_options: dict[str, Any] = {}
        self.session_options: dict[str, Any] = {}
        self.prompts: list[str] = []
        self.effects: list[str] = []
        self.output = json.dumps({"text": "answer", "proposal": {"title": "draft", "body": "body"}})
        self.error: Exception | None = None
        self.gate: asyncio.Event | None = None
        self.start_gate: asyncio.Event | None = None
        self.starting = asyncio.Event()
        self.started = asyncio.Event()
        self.ignore_cancel = False
        self.permission = False
        self.delete_error = False
        self.native_version = "1.0.102"
        self.created = 0
        self.stopped = 0
        self.aborted = 0
        self.deleted: list[str] = []
        self.disconnected = 0
        self.forced = 0
        self.stop_error = False
        self.ram: Any = None

    def client(self, **kwargs: Any) -> Any:
        self.created += 1
        self.client_options = kwargs
        return self

    async def start(self) -> None:
        self.starting.set()
        if self.start_gate:
            await self.start_gate.wait()

    async def get_status(self) -> Any:
        return SimpleNamespace(version=self.native_version, protocol_version=3)

    async def create_session(self, **kwargs: Any) -> Any:
        self.session_options = kwargs
        self.ram = kwargs["create_session_fs_handler"]("synthetic-session")
        return SimpleNamespace(
            session_id="synthetic-session",
            send_and_wait=self.send,
            abort=self.abort,
            disconnect=self.disconnect,
        )

    async def send(self, prompt: str, **kwargs: Any) -> Any:
        self.prompts.append(prompt)
        self.started.set()
        await self.ram.write_file("/sage/state/events", "synthetic-private-marker")
        base = Path(self.client_options["base_directory"])
        (base / "synthetic-artifact").write_text("synthetic-private-marker")
        if self.permission:
            decision = self.session_options["on_permission_request"]({"kind": "shell"}, {})
            if decision.kind != "reject":
                self.effects.append("shell")
        if self.gate:
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                if not self.ignore_cancel:
                    raise
                await self.gate.wait()
        if self.error:
            raise self.error
        return SimpleNamespace(data=SimpleNamespace(content=self.output))

    async def abort(self) -> None:
        self.aborted += 1

    async def disconnect(self) -> None:
        self.disconnected += 1
        if self.delete_error:
            raise OSError("synthetic-private-marker")

    async def delete_session(self, session_id: str) -> None:
        self.deleted.append(session_id)
        if self.delete_error:
            raise OSError("synthetic-private-marker")

    async def stop(self) -> None:
        self.stopped += 1
        if self.stop_error:
            raise OSError("synthetic-private-marker")

    async def force_stop(self) -> None:
        self.forced += 1
