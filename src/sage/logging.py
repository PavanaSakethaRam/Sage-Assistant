"""Default diagnostics are closed static codes, never exception text or caller IDs."""

import sys
from typing import Literal

Diagnostic = Literal[
    "core_started",
    "core_stopped",
    "request_failed",
    "transport_failed",
    "invalid_frame",
    "startup_failed",
    "retention_failed",
]


def diagnostic(code: Diagnostic) -> None:
    print(code, file=sys.stderr, flush=True)
