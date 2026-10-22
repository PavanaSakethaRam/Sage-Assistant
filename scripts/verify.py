"""One aggregate run, with deterministic execution separated from advisory scans."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UV = str(ROOT / ".venv" / ("Scripts/uv.exe" if os.name == "nt" else "bin/uv"))
NPM = "npm.cmd" if os.name == "nt" else "npm"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deterministic", action="store_true")
    parser.add_argument("--base", default="3b953a95ae44e81e05b31c0d9964595d0b1c0d43")
    args = parser.parse_args()
    uv = [UV, "run", "--locked", "--no-sync"]
    commands = [
        uv + ["pytest", "--cov=sage", "--cov-branch", "--cov-report=json"],
        [NPM, "run", "test:coverage"],
        [NPM, "run", "test:e2e"],
        [
            sys.executable,
            "scripts/check_coverage.py",
            "--python",
            "coverage.json",
            "--javascript",
            "coverage/coverage-summary.json",
        ],
        [NPM, "run", "typecheck"],
        [NPM, "run", "lint"],
        uv + ["mypy"],
        uv + ["ruff", "check", "src", "tests", "scripts", "e2e", "desktop/tests/fixtures"],
        uv
        + ["ruff", "format", "--check", "src", "tests", "scripts", "e2e", "desktop/tests/fixtures"],
        [NPM, "run", "format:check"],
    ]
    if not args.deterministic:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        commands.append(
            [sys.executable, "scripts/verify_security.py", "--base", args.base, "--head", head]
        )
    results = []
    for command in commands:
        # Fixed reviewed argv only; no user code interpolated into a shell.
        print("VERIFY " + " ".join(command), flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        results.append({"command": command, "exit_code": result.returncode})
    output = ROOT / "coverage/verification.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, indent=2) + "\n")
    return int(any(result["exit_code"] for result in results))


if __name__ == "__main__":
    raise SystemExit(main())
