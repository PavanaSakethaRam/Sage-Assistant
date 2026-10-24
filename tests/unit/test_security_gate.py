"""Collection failures and untriaged secret findings cannot turn green."""

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

PATH = Path(__file__).resolve().parents[2] / "scripts/verify_security.py"


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_security", PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_secret_report_drops_source_values() -> None:
    result = load().secret_result(
        2,
        [
            {
                "RuleID": "generic-api-key",
                "File": "src/example.py",
                "StartLine": 4,
                "Secret": "private-marker",
                "Match": "private-marker",
                "Line": "private-marker",
            }
        ],
        "",
    )
    assert result["status"] == "violations"
    assert "private-marker" not in str(result)
    assert result["findings"] == [
        {"rule": "generic-api-key", "path": "src/example.py", "line": 4, "triage": "untriaged"}
    ]


@pytest.mark.parametrize(
    ("code", "data", "diagnostics"),
    [(1, [], ""), (0, {}, ""), (0, [], "warning: skipped file"), (0, [{"RuleID": "x"}], "")],
)
def test_secret_incomplete_fails_closed(code: int, data: object, diagnostics: str) -> None:
    assert load().secret_result(code, data, diagnostics)["status"] == "incomplete"


def test_advisory_severity_unknown_is_unresolved() -> None:
    assert (
        load().python_result(
            1,
            {
                "dependencies": [
                    {
                        "name": "example",
                        "version": "1",
                        "vulns": [{"id": "PYSEC-example", "aliases": []}],
                    }
                ]
            },
            {"example": "1"},
        )["status"]
        == "violations"
    )


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"dependencies": []},
        {"dependencies": [{"name": "example", "version": "2", "vulns": []}]},
    ],
)
def test_python_missing_inventory_fails(data: object) -> None:
    assert load().python_result(0, data, {"example": "1"})["status"] == "incomplete"


def test_large_real_bandit_scan_has_complete_json_and_retains_lower_findings(
    tmp_path: Path,
) -> None:
    root = tmp_path / "scanner-fixtures"
    root.mkdir()
    for index in range(51):
        (root / f"sample_{index}.py").write_text("assert True\n")
    code, data, _ = load().collect_bandit([str(root)])
    assert code == 1
    assert isinstance(data, dict) and data["errors"] == []
    assert len(data["metrics"]) == 52  # every file plus _totals
    assert len(data["results"]) == 51
    assert {finding["test_id"] for finding in data["results"]} == {"B101"}


@pytest.fixture
def owned_eslint_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[ModuleType, list[dict[str, object]], Path]:
    module = load()
    root = tmp_path / "owned"
    for name in [
        "desktop/owned.ts",
        "extension/src/owned.ts",
        "scripts/check_owned.mjs",
        "extension/dist/bundle.cjs",
        "extension/native/owned.c",
    ]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("/* owned */\n")
    versions = {"@playwright/test": "1.64.1", "eslint-plugin-security": "4.2.0"}
    lock = {"packages": {"node_modules/" + name: {"version": v} for name, v in versions.items()}}
    (root / "package-lock.json").write_text(json.dumps(lock))
    for name, version in versions.items():
        path = root / "node_modules" / name / "package.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": version}))
    (root / "scripts/coverage-manifest.json").write_text(
        json.dumps(
            {"native": ["extension/native/owned.c"], "trusted_native": ["extension/native/owned.c"]}
        )
    )
    scanner = root / "gitleaks"
    scanner.write_bytes(b"owned scanner double")
    scanner.with_suffix(".sha256").write_text(hashlib.sha256(scanner.read_bytes()).hexdigest())
    monkeypatch.setattr(module, "ROOT", root)
    monkeypatch.setattr(module, "GITLEAKS", scanner)
    monkeypatch.setattr(
        module, "os", SimpleNamespace(name="posix", uname=lambda: SimpleNamespace(machine="arm64"))
    )
    output = root / "result.json"
    monkeypatch.setattr(
        module,
        "sys",
        SimpleNamespace(
            platform="darwin",
            version=sys.version,
            executable=sys.executable,
            argv=[
                "verify_security.py",
                "--base",
                "a" * 40,
                "--head",
                "b" * 40,
                "--output",
                str(output),
            ],
        ),
    )
    monkeypatch.setattr(sys, "argv", module.sys.argv)
    rows: list[dict[str, object]] = [
        {"filePath": str(root / name), "errorCount": 0, "messages": []}
        for name in [
            "desktop/owned.ts",
            "extension/src/owned.ts",
            "scripts/check_owned.mjs",
            "extension/dist/bundle.cjs",
        ]
    ]

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[object]:
        return subprocess.CompletedProcess(
            args, 0, stdout="8.30.1\n" if kwargs.get("text") else b"", stderr=""
        )

    monkeypatch.setattr(module.subprocess, "run", run)
    monkeypatch.setattr(module, "python_result", lambda *args: {"status": "pass"})
    monkeypatch.setattr(module, "npm_result", lambda *args: {"status": "pass"})
    monkeypatch.setattr(
        module,
        "collect_bandit",
        lambda targets: (0, {"errors": [], "metrics": {}, "results": []}, ""),
    )

    def execute(args: list[str]) -> tuple[int, object, str]:
        if args[0] == str(scanner):
            if any(Path(arg).name == "probe" for arg in args):
                return 2, [{"RuleID": "synthetic", "File": "synthetic.txt", "StartLine": 1}], ""
            return 0, [], ""
        if "--output-file" in args:
            Path(args[args.index("--output-file") + 1]).write_text("")
            (root / "uv.lock").write_text("package = []\n")
        if "eslint.security.config.mjs" in args:
            return 0, module.eslint_data, ""
        return 0, {}, ""

    monkeypatch.setattr(module, "execute", execute)
    monkeypatch.setattr(module, "eslint_data", rows, raising=False)
    return module, rows, output


@pytest.mark.parametrize(
    "damage",
    ["extension", "checker", "missing_list", "malformed_list", "error_count", "generated"],
)
def test_eslint_discovery_and_full_gate_require_complete_owned_inventory(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    damage: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, rows, output = owned_eslint_scan
    assert module.main() == 0
    baseline = json.loads(output.read_text())
    assert baseline["eslint"]["status"] == "pass"
    assert baseline["eslint"]["files"] == 4
    if damage in {"extension", "checker"}:
        rows.pop(1 if damage == "extension" else 2)
    elif damage == "missing_list":
        monkeypatch.setattr(module, "eslint_data", None)
    elif damage == "malformed_list":
        monkeypatch.setattr(module, "eslint_data", {})
    elif damage == "error_count":
        rows[1]["errorCount"] = 1
    elif damage == "generated":
        rows.pop(3)
    # Generated .cjs output can be omitted; it is not maintained source.
    assert module.main() == (0 if damage == "generated" else 1)
    result = json.loads(output.read_text())
    assert result["eslint"]["status"] == ("pass" if damage == "generated" else "incomplete")
    if damage != "generated":
        assert result["eslint"]["reason"] == "JavaScript static collection failed"
    for section in [
        "native",
        "python",
        "node",
        "bandit",
        "secrets_current",
        "secrets_diff",
        "secret_sensitivity",
    ]:
        assert result[section]["status"] == "pass"


@pytest.mark.parametrize("count", ["missing", None, False, 0.0, "", [], {}, -1, "0", True])
def test_eslint_rejects_missing_or_malformed_error_counts(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path], count: object
) -> None:
    module, rows, output = owned_eslint_scan
    rows[1]["warningCount"] = 0  # Ordinary extra ESLint keys remain accepted.
    assert module.main() == 0
    assert json.loads(output.read_text())["eslint"]["status"] == "pass"
    if count == "missing":
        del rows[1]["errorCount"]
    else:
        rows[1]["errorCount"] = count
    assert module.main() == 1
    assert json.loads(output.read_text())["eslint"] == {
        "status": "incomplete",
        "reason": "JavaScript static collection failed",
    }


def test_eslint_rejects_malformed_file_rows(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, _, output = owned_eslint_scan
    assert module.main() == 0
    monkeypatch.setattr(module, "eslint_data", [None])
    assert module.main() == 1
    assert json.loads(output.read_text())["eslint"] == {
        "status": "incomplete",
        "reason": "JavaScript static collection failed",
    }
