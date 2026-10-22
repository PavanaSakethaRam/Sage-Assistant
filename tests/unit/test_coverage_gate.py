"""A rounded percentage, omitted source, or weak branch gate must never pass."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def reports(
    tmp_path: Path, statements: tuple[int, int] = (90, 100), branches: tuple[int, int] = (85, 100)
) -> tuple[Path, Path]:
    manifest = json.loads((ROOT / "scripts/coverage-manifest.json").read_text())
    py = {}
    js = {}
    for name in manifest["python"]:
        py[name] = {
            "summary": {
                "covered_lines": statements[0],
                "num_statements": statements[1],
                "covered_branches": branches[0],
                "num_branches": branches[1],
            }
        }
    for name in manifest["javascript"]:
        js[name] = {
            "statements": {"covered": statements[0], "total": statements[1]},
            "branches": {"covered": branches[0], "total": branches[1]},
        }
    p, j = tmp_path / "python.json", tmp_path / "js.json"
    p.write_text(json.dumps({"files": py}))
    j.write_text(json.dumps(js))
    return p, j


def run(p: Path, j: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/check_coverage.py"),
            "--python",
            str(p),
            "--javascript",
            str(j),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_exact_thresholds_pass(tmp_path: Path) -> None:
    p, j = reports(tmp_path)
    assert run(p, j).returncode == 0


@pytest.mark.parametrize(
    ("statements", "branches"),
    [
        ((89, 100), (85, 100)),
        ((90, 100), (84, 100)),
        ((89999, 100000), (85, 100)),
        ((90, 100), (84999, 100000)),
    ],
)
def test_separate_thresholds_and_rounding_fail(
    tmp_path: Path, statements: tuple[int, int], branches: tuple[int, int]
) -> None:
    p, j = reports(tmp_path, statements, branches)
    assert run(p, j).returncode == 1


@pytest.mark.parametrize(
    "damage",
    [
        "missing",
        "empty",
        "malformed",
        "missing_trusted",
        "uncovered",
        "invalid_count",
        "missing_ordinary",
    ],
)
@pytest.mark.parametrize("language", ["python", "javascript"])
def test_incomplete_artifacts_fail_closed(tmp_path: Path, damage: str, language: str) -> None:
    p, j = reports(tmp_path)
    target = p if language == "python" else j
    data = json.loads(target.read_text())
    entries = data["files"] if language == "python" else data
    key = next(iter(entries))
    if damage == "missing":
        target.unlink()
    elif damage == "empty":
        target.write_text("{}")
    elif damage == "malformed":
        target.write_text("{")
    else:
        if damage == "missing_trusted":
            del entries[key]
        elif damage == "missing_ordinary":
            del entries[next(reversed(entries))]
        elif damage == "uncovered":
            if language == "python":
                entries[key]["summary"]["covered_lines"] = 0
            else:
                entries[key]["statements"]["covered"] = 0
        else:
            if language == "python":
                entries[key]["summary"]["covered_lines"] = True
            else:
                entries[key]["branches"]["total"] = -1
        target.write_text(json.dumps(data))
    assert run(p, j).returncode == 1


@pytest.mark.parametrize(
    ("statements", "branches", "expected"), [(8000, 7500, 0), (7999, 7500, 1), (8000, 7499, 1)]
)
def test_ordinary_gate_has_independent_exact_thresholds(
    tmp_path: Path, statements: int, branches: int, expected: int
) -> None:
    p, j = reports(tmp_path, (100, 100), (100, 100))
    manifest = json.loads((ROOT / "scripts/coverage-manifest.json").read_text())
    trusted = manifest["trusted_javascript"]
    entries = json.loads(j.read_text())
    for name in entries:
        covered = int(name in trusted)
        entries[name] = {
            "statements": {"covered": covered, "total": covered},
            "branches": {"covered": covered, "total": covered},
        }
    entries["desktop/renderer/App.tsx"] = {
        "statements": {"covered": statements - len(trusted), "total": 10000 - len(trusted)},
        "branches": {"covered": branches - len(trusted), "total": 10000 - len(trusted)},
    }
    j.write_text(json.dumps(entries))
    assert run(p, j).returncode == expected


def portable_python_paths(path: Path, style: str) -> None:
    report = json.loads(path.read_text())
    entries = {}
    for name, value in report["files"].items():
        key = str(ROOT / name) if style.startswith("absolute") else name
        if style.endswith("windows"):
            key = key.replace("/", "\\")
        entries[key] = value
    report["files"] = entries
    path.write_text(json.dumps(report))


@pytest.mark.parametrize("style", ["relative_windows", "absolute_native", "absolute_windows"])
def test_portable_python_paths_preserve_passing_counts(tmp_path: Path, style: str) -> None:
    p, j = reports(tmp_path)
    portable_python_paths(p, style)
    assert run(p, j).returncode == 0


@pytest.mark.parametrize("style", ["relative_windows", "absolute_native", "absolute_windows"])
def test_portable_python_paths_still_require_each_source(tmp_path: Path, style: str) -> None:
    p, j = reports(tmp_path)
    report = json.loads(p.read_text())
    del report["files"]["src/sage/storage.py"]
    p.write_text(json.dumps(report))
    portable_python_paths(p, style)
    assert run(p, j).returncode == 1


@pytest.mark.parametrize("alias", ["src\\sage\\storage.py", str(ROOT / "src/sage/storage.py")])
@pytest.mark.parametrize("alias_first", [False, True])
def test_python_report_rejects_colliding_source_identities(
    tmp_path: Path, alias: str, alias_first: bool
) -> None:
    p, j = reports(tmp_path)
    report = json.loads(p.read_text())
    duplicate = {alias: report["files"]["src/sage/storage.py"]}
    report["files"] = (
        {**duplicate, **report["files"]} if alias_first else {**report["files"], **duplicate}
    )
    p.write_text(json.dumps(report))
    assert run(p, j).returncode == 1


@pytest.mark.parametrize("files", [[], None, "malformed"])
def test_invalid_python_file_map_remains_a_static_failure(tmp_path: Path, files: object) -> None:
    p, j = reports(tmp_path)
    p.write_text(json.dumps({"files": files}))
    result = run(p, j)
    assert result.returncode == 1
    assert result.stdout.startswith("coverage gate failed:")
    assert result.stderr == ""
