"""One local core owner and a closed private request dispatcher."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Literal, Protocol
from uuid import uuid4

from pydantic import AfterValidator, Field, ValidationError, field_validator

from sage.actions import ActionService
from sage.config import Settings
from sage.contracts import Backend, Contract, NoteContent, Revision, _context_text
from sage.logging import diagnostic
from sage.protocol import (
    ErrorCode,
    Failure,
    ProtocolError,
    Request,
    Response,
    RpcId,
    encode_frame,
    failure,
    read_frame,
    request,
)
from sage.storage import Store


class Empty(Contract):
    pass


class Page(Contract):
    limit: Annotated[int, Field(ge=1, le=100)] = 20
    offset: Annotated[int, Field(ge=0, le=1_000_000)] = 0


class Search(Page):
    query: Annotated[str, Field(max_length=32_000), AfterValidator(_context_text)]


class NoteId(Contract):
    note_id: RpcId


class TaskId(Contract):
    task_id: RpcId


class ReviewId(Contract):
    proposal_id: RpcId
    revision: Revision


class RevisionInput(ReviewId, NoteContent):
    pass


class Decision(ReviewId):
    decision: Literal["save", "cancel"]


class Cancel(Contract):
    request_id: RpcId


class ReasoningInput(Contract):
    user_text: Annotated[str, Field(max_length=32_000)]
    attached_context: list[str] = Field(default_factory=list, max_length=64_000)
    backend: Backend
    model: Annotated[str, Field(max_length=200)] | None = None

    @field_validator("user_text")
    @classmethod
    def text_controls(cls, value: str) -> str:
        return _context_text(value)

    @field_validator("attached_context")
    @classmethod
    def context_limit(cls, value: list[str]) -> list[str]:
        if sum(map(len, value)) > 64_000:
            raise ValueError("Context too large")
        for part in value:
            _context_text(part)
        return value


class CoreService:
    """Startup owns one Store and one long-lived ActionService with a fresh boot."""

    def __init__(self, store: Store, clock: Callable[[], datetime] | None = None) -> None:
        self.store = store
        self.clock = clock or (lambda: datetime.now(UTC))
        self.actions = ActionService(store, self.clock, uuid4().hex)
        self._seen: set[str] = set()
        self.shutting_down = False
        self.store.interrupt_inference(self.clock())

    def close(self) -> None:
        self.shutting_down = True
        self.store.close()

    async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
        try:
            envelope = request(message)
        except ProtocolError:
            return failure(None, "invalid_request")
        if envelope.id in self._seen:
            return failure(envelope.id, "duplicate_id")
        if len(self._seen) >= 4096:
            return failure(envelope.id, "session_limit")
        self._seen.add(envelope.id)
        if self.shutting_down:
            return failure(envelope.id, "shutting_down")
        try:
            value = self._dispatch(envelope)
            return Response(id=envelope.id, result=value).model_dump(mode="json")
        except LookupError:
            return failure(envelope.id, "not_found")
        except (ValueError, ValidationError):
            return failure(envelope.id, "invalid_request")
        except Exception:
            diagnostic("request_failed")
            return failure(envelope.id, "internal_error")

    def _dispatch(self, envelope: Request) -> dict[str, object]:
        params = envelope.params
        match envelope.method:
            case "settings.get":
                Empty.model_validate(params)
                with self.store.transaction() as db:
                    row = db.execute("SELECT data_json FROM settings WHERE id=1").fetchone()
                settings = Settings.model_validate_json(row[0]) if row else Settings()
                return settings.model_dump(mode="json")
            case "settings.update":
                settings = Settings.model_validate(params)
                with self.store.transaction() as db:
                    db.execute(
                        "INSERT INTO settings (id,data_json) VALUES (1,?) "
                        "ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
                        (settings.model_dump_json(),),
                    )
                return settings.model_dump(mode="json")
            case "readiness.list":
                Empty.model_validate(params)
                return {
                    "items": [
                        {
                            "provider": provider,
                            "status": "unavailable",
                            "evidence": [],
                            "version": None,
                            "destination": None,
                            "explanation": "inference_unavailable",
                        }
                        for provider in ("copilot", "local", "api")
                    ]
                }
            case "reasoning.start":
                ReasoningInput.model_validate(params)
                return {"status": "unavailable", "code": "inference_unavailable"}
            case "connection.test":
                Empty.model_validate(params)
                return {"status": "unavailable", "code": "inference_unavailable"}
            case "reasoning.cancel":
                Cancel.model_validate(params)
                return {"status": "unknown_request"}
            case "notes.propose":
                note = NoteContent.model_validate(params)
                return self.actions.propose_note(uuid4().hex, note.title, note.body).model_dump(
                    mode="json"
                )
            case "notes.revise":
                edit = RevisionInput.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.revise_note(
                    edit.proposal_id, edit.revision, edit.title, edit.body
                ).model_dump(mode="json")
            case "notes.decide":
                decision = Decision.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.decide(
                    decision.proposal_id, decision.revision, decision.decision
                ).model_dump(mode="json")
            case "notes.get":
                note_id = NoteId.model_validate(params)
                saved = self.store.get_note(note_id.note_id)
                if saved is None:
                    raise LookupError
                return saved.model_dump(mode="json")
            case "notes.list" | "notes.search":
                page = (
                    Search.model_validate(params)
                    if envelope.method == "notes.search"
                    else Page.model_validate(params)
                )
                query = page.query if isinstance(page, Search) else None
                items = self.store.note_summaries(page.limit + 1, page.offset, query)
                return self._page(items, page)
            case "tasks.list":
                page = Page.model_validate(params)
                self.store.cleanup(self.clock())
                return self._page(self.store.task_summaries(page.limit + 1, page.offset), page)
            case "tasks.get":
                task = TaskId.model_validate(params)
                self.store.cleanup(self.clock())
                detail = self.store.task_detail(task.task_id)
                if detail is None:
                    raise LookupError
                outcome = self.actions.get_outcome(task.task_id)
                detail["outcome"] = outcome.model_dump(mode="json") if outcome else None
                return detail
            case "tasks.cancel":
                task = TaskId.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.cancel_task(task.task_id).model_dump(mode="json")
            case "app.shutdown":
                Empty.model_validate(params)
                self.shutting_down = True
                return {"status": "shutting_down"}
            case _:
                raise ValueError("Unknown method")

    @staticmethod
    def _page(items: list[dict[str, object]], page: Page) -> dict[str, object]:
        return {
            "items": items[: page.limit],
            "next_offset": page.offset + page.limit if len(items) > page.limit else None,
        }


class Writer(Protocol):
    def write(self, data: bytes) -> None: ...
    async def drain(self) -> None: ...
    def close(self) -> None: ...
    async def wait_closed(self) -> None: ...


async def run_service(reader: asyncio.StreamReader, writer: Writer, service: CoreService) -> None:
    """One connection, at most eight requests; cancellation invalidates late output.

    Provider work added by Task 5 must remain awaited inside dispatch, propagate
    CancelledError, and check its request/task identity before emitting proposals.
    This loop emits exactly one terminal frame per accepted request; children
    never write stdout themselves. No unbounded output/progress queue exists.
    """
    pending: dict[str, tuple[Request, asyncio.Task[None]]] = {}
    lock = asyncio.Lock()
    broken = False
    ready: set[str] = set()
    invalidated: dict[str, ErrorCode] = {}
    suppressed: set[str] = set()
    stopped = asyncio.Event()
    incoming: asyncio.Task[dict[str, object]] | None = None

    async def send(message: dict[str, object]) -> None:
        nonlocal broken
        if broken:
            return
        try:
            async with lock:
                writer.write(encode_frame(message))
                await asyncio.wait_for(writer.drain(), 5)
        except (OSError, TimeoutError, ProtocolError):
            broken = True
            stopped.set()
            diagnostic("transport_failed")

    async def execute(envelope: Request, message: dict[str, object]) -> None:
        deadline = asyncio.timeout(envelope.timeout_ms / 1000)
        try:
            async with deadline:
                response = await service.dispatch(message)
        except TimeoutError:
            response = failure(envelope.id, "timeout")
        except asyncio.CancelledError:
            response = failure(envelope.id, "cancelled")
        except Exception:
            diagnostic("request_failed")
            response = failure(envelope.id, "internal_error")
        if deadline.expired():
            response = failure(envelope.id, "timeout")
        if envelope.id in invalidated:
            response = failure(envelope.id, invalidated[envelope.id])
        # Only a closed, correctly correlated terminal envelope may reach the pipe.
        try:
            if response.get("id") != envelope.id or type(response.get("version")) is not int:
                raise ValueError
            schema = Response if response.get("kind") == "response" else Failure
            response = schema.model_validate(response).model_dump(mode="json")
        except (ValueError, ValidationError):
            response = failure(envelope.id, "internal_error")
        ready.add(envelope.id)
        try:
            if envelope.id not in suppressed:
                await send(response)
        finally:
            pending.pop(envelope.id, None)
            ready.discard(envelope.id)
            invalidated.pop(envelope.id, None)
            suppressed.discard(envelope.id)

    async def retention() -> None:
        while True:
            await asyncio.sleep(60)
            try:
                service.store.cleanup(service.clock())
            except Exception:
                diagnostic("retention_failed")

    cleanup = asyncio.create_task(retention())
    stop_waiter = asyncio.create_task(stopped.wait())
    try:
        while not broken and not service.shutting_down:
            try:
                incoming = asyncio.create_task(read_frame(reader))
                done, _ = await asyncio.wait(
                    (incoming, stop_waiter), return_when=asyncio.FIRST_COMPLETED
                )
                if stop_waiter in done:
                    break
                message = incoming.result()
            except EOFError:
                break
            except (ProtocolError, TimeoutError):
                await send(failure(None, "invalid_frame"))
                break
            try:
                envelope = request(message)
            except ProtocolError:
                await send(failure(None, "invalid_request"))
                continue
            if envelope.id in pending:
                suppressed.add(envelope.id)
                pending[envelope.id][1].cancel()
                await send(failure(envelope.id, "duplicate_id"))
                break
            if envelope.method == "reasoning.cancel":
                try:
                    cancellation = Cancel.model_validate(envelope.params)
                except ValidationError:
                    await send(await service.dispatch(message))
                    continue
                target = pending.get(cancellation.request_id)
                response = await service.dispatch(message)
                if (
                    response.get("kind") == "response"
                    and target is not None
                    and target[0].method == "reasoning.start"
                ):
                    invalidated[cancellation.request_id] = "cancelled"
                    target[1].cancel()
                    response = Response(id=envelope.id, result={"status": "cancelled"}).model_dump(
                        mode="json"
                    )
                await send(response)
                continue
            if len(pending) >= 8:
                await send(failure(envelope.id, "busy"))
                break
            task = asyncio.create_task(execute(envelope, message))
            pending[envelope.id] = (envelope, task)
            # Give shutdown and local effects their ordering point before the next read.
            await asyncio.sleep(0)
        for identifier, (_, task) in list(pending.items()):
            if identifier not in ready:
                invalidated.setdefault(identifier, "cancelled")
                task.cancel()
        await asyncio.gather(*(task for _, task in list(pending.values())), return_exceptions=True)
    finally:
        cleanup.cancel()
        stop_waiter.cancel()
        if incoming is not None:
            incoming.cancel()
            await asyncio.gather(incoming, return_exceptions=True)
        await asyncio.gather(cleanup, stop_waiter, return_exceptions=True)
        for identifier, (_, task) in list(pending.items()):
            invalidated.setdefault(identifier, "cancelled")
            task.cancel()
        await asyncio.gather(*(task for _, task in list(pending.values())), return_exceptions=True)
        writer.close()
        try:
            await asyncio.wait_for(writer.wait_closed(), 5)
        except (OSError, TimeoutError):
            diagnostic("transport_failed")
