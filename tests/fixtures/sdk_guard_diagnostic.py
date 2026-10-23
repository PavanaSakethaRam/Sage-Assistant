"""Failure-only public SDK probe: report fixed denial labels, never paths or content."""

import json
import os
import sys
from typing import Any

sys.path.insert(0, sys.argv[1])
from sage.sdk_probe import CapabilityGuard, Category, probe  # noqa: E402

EVENTS = {
    "import",
    "open",
    "os.listdir",
    "os.scandir",
    "metadata_read",
    "socket",
    "subprocess",
    "sqlite3",
    "winreg",
    "ctypes",
    "os.other",
    "other",
}


class DiagnosticGuard(CapabilityGuard):
    def __init__(self) -> None:
        super().__init__()
        self.current_event = "other"
        self.path_class = "none"
        self.first_denial: dict[str, str] | None = None
        self.in_audit = False

    def classify(self, path: Any) -> str:
        if not isinstance(path, (str, bytes, os.PathLike)):
            return "non_path"
        try:
            name = os.path.normcase(os.path.abspath(os.fsdecode(path)))
        except (TypeError, ValueError, OSError):
            return "invalid_path"
        if self.container is not None and name == os.path.normcase(self.container):
            return "container"
        for index, root in enumerate(self.roots):
            normalized = os.path.normcase(root)
            if name == normalized or name.startswith(normalized + os.sep):
                return f"trusted_{index}"
        return "outside"

    def audit(self, event: str, args: tuple[Any, ...]) -> None:
        if event in EVENTS:
            self.current_event = event
        elif event.startswith(("socket.", "subprocess.", "sqlite3.", "winreg.", "ctypes.")):
            self.current_event = event.split(".", 1)[0]
        elif event.startswith("os."):
            self.current_event = "os.other"
        else:
            self.current_event = "other"
        self.path_class = (
            self.classify(args[0])
            if event in {"open", "os.listdir", "os.scandir"} and args
            else "none"
        )
        self.in_audit = True
        try:
            super().audit(event, args)
        finally:
            self.in_audit = False

    def read(self, path: Any) -> None:
        if not self.in_audit:
            self.current_event = "metadata_read"
        self.path_class = self.classify(path)
        super().read(path)

    def deny(self, category: Category) -> Any:
        if self.first_denial is None:
            self.first_denial = {
                "event": self.current_event,
                "path_class": self.path_class,
            }
        return super().deny(category)


sink = sys.stdout
guard = DiagnosticGuard()
result = probe(guard)
record = {
    "stage": result["stage"],
    "category": result["category"],
    "event": (guard.first_denial or {}).get("event", "none"),
    "path_class": (guard.first_denial or {}).get("path_class", "none"),
}
sink.write(json.dumps(record, separators=(",", ":")) + "\n")
sink.flush()
