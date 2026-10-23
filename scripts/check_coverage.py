"""Validate integer coverage counts against the complete reviewed source inventory."""

import argparse
import json
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


def check(python: Path, javascript: Path) -> dict[str, object]:
    manifest = json.loads((ROOT / "scripts/coverage-manifest.json").read_text())
    actual_py = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "src/sage").rglob("*.py"))
    actual_js = sorted(
        p.relative_to(ROOT).as_posix()
        for p in (ROOT / "desktop").rglob("*")
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
    result: dict[str, object] = {}
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
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.python, args.javascript), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        # No source text or artifact contents are echoed.
        label = str(error) if isinstance(error, CoverageThresholdError) else type(error).__name__
        print(f"coverage gate failed: {label}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
