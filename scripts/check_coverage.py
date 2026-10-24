"""Validate integer coverage counts against the complete reviewed source inventory."""

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


class CoverageThresholdError(ValueError):
    """A fixed scope and metric label; never include report data in diagnostics."""


def count(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("invalid coverage count")
    return value


def pair(covered: Any, total: Any) -> tuple[int, int]:
    c, t = count(covered), count(total)
    if c > t:
        raise ValueError("covered count exceeds total")
    return c, t


def check(python: Path, javascript: Path, native: Path) -> dict[str, object]:
    manifest = json.loads((ROOT / "scripts/coverage-manifest.json").read_text())
    actual_py = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "src/sage").rglob("*.py"))
    actual_js = sorted(
        p.relative_to(ROOT).as_posix()
        for tree in [ROOT / "desktop", ROOT / "extension/src"]
        for p in tree.rglob("*")
        if p.suffix in {".ts", ".tsx"} and "tests" not in p.relative_to(ROOT).parts
    )
    if manifest["python"] != actual_py or manifest["javascript"] != actual_js:
        raise ValueError("source inventory drift; review manifest")
    files = json.loads(python.read_text())["files"]
    if not isinstance(files, dict):
        raise ValueError("invalid Python file map")
    py = {}
    for filename, data in files.items():
        identity = Path(filename.replace("\\", "/")).as_posix().removeprefix(ROOT.as_posix() + "/")
        if identity in py:
            raise ValueError("ambiguous Python source identity")
        py[identity] = data
    js = json.loads(javascript.read_text())
    js = {Path(k).as_posix().removeprefix(ROOT.as_posix() + "/"): v for k, v in js.items()}
    counts: dict[str, dict[str, tuple[tuple[int, int], tuple[int, int]]]] = {
        "python": {},
        "javascript": {},
    }
    for name in manifest["python"]:
        s = py[name]["summary"]
        counts["python"][name] = (
            pair(s["covered_lines"], s["num_statements"]),
            pair(s["covered_branches"], s["num_branches"]),
        )
    for name in manifest["javascript"]:
        s = js[name]
        counts["javascript"][name] = (
            pair(s["statements"]["covered"], s["statements"]["total"]),
            pair(s["branches"]["covered"], s["branches"]["total"]),
        )
    actual_native = sorted(
        p.relative_to(ROOT).as_posix() for p in (ROOT / "extension/native").glob("*.c")
    )
    if manifest["native"] != actual_native or manifest["trusted_native"] != actual_native:
        raise ValueError("native source inventory drift")
    packet = json.loads(native.read_text())
    expected_platform = (
        "darwin-arm64"
        if sys.platform == "darwin" and platform.machine() == "arm64"
        else "win32-x64"
        if sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"}
        else "unsupported"
    )
    if (
        type(packet["version"]) is not int
        or packet["version"] != 1
        or packet["platform"] != expected_platform
        or len(packet["binary_sha256"]) != 64
        or any(c not in "0123456789abcdef" for c in packet["binary_sha256"])
        or set(packet["source_sha256"]) != set(actual_native)
    ):
        raise ValueError("invalid native coverage provenance")
    for name in actual_native:
        if packet["source_sha256"][name] != hashlib.sha256((ROOT / name).read_bytes()).hexdigest():
            raise ValueError("native source hash drift")
    native_files = packet["coverage"]["data"][0]["files"]
    native_counts = {}
    for item in native_files:
        name = Path(item["filename"]).as_posix().removeprefix(ROOT.as_posix() + "/")
        if name in native_counts:
            raise ValueError("ambiguous native source")
        summary = item["summary"]
        native_counts[name] = (
            pair(summary["regions"]["covered"], summary["regions"]["count"]),
            pair(summary["branches"]["covered"], summary["branches"]["count"]),
        )
    if sorted(native_counts) != actual_native:
        raise ValueError("incomplete native coverage")
    result: dict[str, object] = {}
    for scope, thresholds in [("maintained", (80, 75)), ("trusted", (90, 85))]:
        sums = [
            tuple(sum(native_counts[n][i][j] for n in actual_native) for j in (0, 1))
            for i in (0, 1)
        ]
        for metric, (covered, total), threshold in zip(
            ("regions", "branches"), sums, thresholds, strict=True
        ):
            if not total or covered * 100 < total * threshold:
                raise CoverageThresholdError(f"native_{scope}_{metric}")
        result[f"native_{scope}"] = {"regions": sums[0], "branches": sums[1]}

    for lang, entries in counts.items():
        trusted = manifest["trusted_" + lang]
        if not trusted or not set(trusted) <= set(entries):
            raise ValueError("invalid trusted manifest")
        for scope, names, thresholds in [
            ("maintained", list(entries), (80, 75)),
            ("trusted", trusted, (90, 85)),
        ]:
            sums = [tuple(sum(entries[n][i][j] for n in names) for j in (0, 1)) for i in (0, 1)]
            for metric, (c, t), threshold in zip(
                ("statements", "branches"), sums, thresholds, strict=True
            ):
                if not t or c * 100 < t * threshold:
                    raise CoverageThresholdError(f"{lang}_{scope}_{metric}")
            # Do not hide an entirely unexecuted trusted module in aggregate numbers.
            for n in trusted:
                c, t = entries[n][0]
                if t and not c:
                    raise ValueError(f"uncovered trusted source: {n}")
            result[f"{lang}_{scope}"] = {"statements": sums[0], "branches": sums[1]}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--javascript", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.python, args.javascript, args.native), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        # No source text or artifact contents are echoed.
        label = str(error) if isinstance(error, CoverageThresholdError) else type(error).__name__
        print(f"coverage gate failed: {label}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
