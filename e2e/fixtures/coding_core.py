"""Owned editor authority fixture: actual CoreService, SQLite and constructor-only backend."""

import asyncio
import json
import socket
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sage.coding_contracts import CodeJobView, CodeProposal, disclosure_hash
from sage.contracts import ProviderReadiness
from sage.service import CoreService
from sage.storage import Store

ROOT = Path(sys.argv[sys.argv.index("--root") + 1])
SOURCE = Path(__file__).resolve().parents[2] / "tests/fixtures/focus-project"
NAMES = ("index.html", "focus.js", "focus.test.mjs", "README.md")


class FixtureBackend:
    def coding_readiness(self):
        return ProviderReadiness(provider="copilot", status="ready", explanation="owned fixture")

    async def propose_code(self, request):
        return CodeProposal(
            job_id=request.job_id,
            revision=request.revision,
            explanation="Deterministic owned focus fixture; no provider was contacted.",
            files=[{"name": name, "text": (SOURCE / name).read_text()} for name in NAMES],
        )

    async def cancel(self, request_id):
        pass

    async def aclose(self):
        pass


def deny(*args, **kwargs):
    raise AssertionError("owned coding fixture forbids network/process access")


async def main():
    socket.socket.connect = deny
    socket.socket.connect_ex = deny
    socket.create_connection = deny
    sys.addaudithook(
        lambda name, args: (
            deny() if name in {"subprocess.Popen", "os.system", "os.posix_spawn"} else None
        )
    )
    store = Store.open(ROOT / "coding.sqlite")
    offset = timedelta()
    core = CoreService(
        store, clock=lambda: datetime.now(UTC) + offset, coding_backend=FixtureBackend()
    )
    # Synthetic constructor composition only. No settings, account, token or provider discovery.
    core.coding.configure_selection(
        backend="copilot", account="owned-synthetic", model=None, account_generation=1
    )
    job_id = None
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            value = json.loads(line)
            if value.get("fixture") == "expire":
                offset += timedelta(minutes=31)
                result = {"expired": True}
            elif value.get("fixture") == "proof":
                with store.transaction() as db:
                    effects = db.execute("SELECT count(*) FROM coding_effects").fetchone()[0]
                    grants = db.execute("SELECT count(*) FROM coding_grants").fetchone()[0]
                    tasks = db.execute("SELECT count(*) FROM tasks").fetchone()[0]
                result = {
                    "effects": effects,
                    "grants": grants,
                    "tasks": tasks,
                    "job": core.coding.get(job_id).model_dump(mode="json") if job_id else None,
                }
            elif value.get("kind") == "host_coding":
                result = await core.coding_control(value)
                if value["operation"] == "context":
                    view = CodeJobView.model_validate(result["result"])
                    job_id = view.binding.job_id
                    draft = {
                        "job_id": job_id,
                        "revision": view.binding.revision,
                        "account_generation": 1,
                        "user_text": "Build owned focus fixture",
                        "backend": "copilot",
                    }
                    started = await core.dispatch(
                        {
                            "version": 1,
                            "kind": "request",
                            "id": uuid4().hex,
                            "method": "coding.start",
                            "params": {**draft, "disclosure_hash": disclosure_hash(view, draft)},
                        }
                    )
                    assert "result" in started, started
            else:
                result = await core.dispatch(value)
            print(json.dumps(result), flush=True)
    finally:
        await core.aclose()


asyncio.run(main())
