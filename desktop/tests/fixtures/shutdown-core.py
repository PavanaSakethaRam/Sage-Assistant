"""Synthetic owned SDK/helper boundary for the real host/core shutdown regression."""

import asyncio
import hashlib
import os
import signal
import sys
from pathlib import Path

# Replaced by the owned test wrapper, never the renderer.
PROJECT_ROOT = "__SAGE_TEST_PROJECT__"
sys.path[:0] = [
    PROJECT_ROOT,
    str(Path(PROJECT_ROOT) / "src"),
    str(Path(PROJECT_ROOT) / ".venv/lib/python3.13/site-packages"),
]
import sage.__main__ as entry  # noqa: E402
from sage.providers import protected_auth as auth  # noqa: E402
from sage.providers.copilot import CopilotReasoner  # noqa: E402
from tests.helpers.copilot_fake import FakeSdk  # noqa: E402

root = Path(sys.argv[sys.argv.index("--root") + 1])
runtime = root / "native/copilot-runtime"
runtime.parent.mkdir()
for name in ["copilot-runtime", "runtime.node", ".hostless-runtime-assets-v2"]:
    (runtime.parent / name).touch()
helper = root / "managed-helper"
helper.write_text(
    f"#!{root / 'fixture-python'}\n"
    "import os,signal,subprocess,sys,time\n"
    "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
    "child=subprocess.Popen([sys.executable,'-c',"
    "'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])\n"
    f"open({str(root / 'helper-pids')!r},'w').write(str(os.getpid())+' '+str(child.pid))\n"
    "time.sleep(60)\n"
)
helper.chmod(0o700)
auth.EXECUTABLE_HASHES[auth.platform_key()] = hashlib.sha256(helper.read_bytes()).hexdigest()
auth.EXECUTABLE_SIZES[auth.platform_key()] = helper.stat().st_size
protected = auth.ProtectedSource(helper, root / "protected-config", "synthetic-user")


class SlowAbortSdk(FakeSdk):
    async def send(self, prompt, **kwargs):
        self.native = await asyncio.create_subprocess_exec(
            str(root / "fixture-python"),
            "-c",
            "import time;time.sleep(60)",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            env={"LANG": "C.UTF-8"},
            cwd=root,
        )
        (root / "sdk-pid").write_text(str(self.native.pid))
        (root / "fast-started").touch()
        await asyncio.Event().wait()

    async def abort(self):
        # Within the production public SDK's existing three-second abort budget.
        await asyncio.sleep(1.3)
        await super().abort()

    async def stop(self):
        os.killpg(self.native.pid, signal.SIGKILL)
        await self.native.wait()
        await super().stop()


sdk = SlowAbortSdk()


async def source(identifier, deadline):
    if identifier == "slow-helper":
        return await protected(identifier, deadline)
    return "gho_synthetic"


class ConfiguredReasoner(CopilotReasoner):
    def __init__(self, sessions, **kwargs):
        kwargs.pop("runtime_path", None)
        kwargs.pop("token_source", None)
        super().__init__(
            sessions, runtime_path=runtime, token_source=source, client_factory=sdk.client, **kwargs
        )


entry.CopilotReasoner = ConfiguredReasoner
raise SystemExit(entry.main())
