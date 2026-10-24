"""Collection failures and untriaged secret findings cannot turn green."""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Callable
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
    monkeypatch.setattr(
        module,
        "native_execute",
        lambda args, cwd: (
            0,
            "Apple clang version 17.0.0 (clang-1700.0.0)\nTarget: arm64-apple-darwin24.0.0\n"
            if "--version" in args
            else "",
            "",
        ),
    )
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


def test_failed_native_probe_stops_analysis(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, _, output = owned_eslint_scan
    analyses: list[list[str]] = []

    def native_execute(args: list[str], cwd: Path) -> tuple[int, str, str]:
        if args == ["/usr/bin/clang", "--version"]:
            return 1, "private-marker", ""
        analyses.append(args)
        return 0, "", ""

    monkeypatch.setattr(module, "native_execute", native_execute)
    assert module.main() == 1
    assert json.loads(output.read_text())["native"]["status"] == "incomplete"
    assert analyses == []
    assert "private-marker" not in output.read_text()


def test_native_process_owns_cwd_closes_stdin_and_bounds_combined_output(tmp_path: Path) -> None:
    module = load()
    code, out, err = module.native_execute(
        [sys.executable, "-c", "import os,sys; assert sys.stdin.read() == ''; print(os.getcwd())"],
        tmp_path,
    )
    assert code == 0 and out.strip() == str(tmp_path.resolve()) and err == ""
    for program in [
        "import sys; sys.stdout.buffer.write(b'x'*131073); sys.stderr.buffer.write(b'y'*131073)",
        "import sys; sys.stdout.buffer.write(b'\\xff')",
    ]:
        assert module.native_execute([sys.executable, "-c", program], tmp_path) == (-1, "", "")
    assert module.native_execute([str(tmp_path / "missing")], tmp_path) == (-1, "", "")


def test_native_process_deadline_terminates_owned_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load()
    real_popen = subprocess.Popen
    children = []

    def popen(
        args: list[str], *, cwd: Path, stdin: int, stdout: int, stderr: int, shell: bool
    ) -> subprocess.Popen[bytes]:
        child = real_popen(args, cwd=cwd, stdin=stdin, stdout=stdout, stderr=stderr, shell=shell)
        children.append(child)
        return child

    clock = iter([0, 31])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(module.subprocess, "Popen", popen)
    assert module.native_execute(
        [sys.executable, "-c", "import time; time.sleep(60)"], tmp_path
    ) == (-1, "", "")
    assert len(children) == 1 and children[0].poll() is not None


@pytest.mark.parametrize(
    "probe",
    [
        (
            None,
            "Apple clang version 17.0.0 (clang-1700.0.0)\nTarget: arm64-apple-darwin24.0.0\n",
            "",
        ),
        (0, "", ""),
        (0, "private-marker", ""),
        (0, "Apple clang version 17.0.0\nTarget: x86_64-apple-darwin24.0.0\n", ""),
        (0, "Apple clang version 17.0.0\nTarget: arm64-apple-darwin24.0.0\n", "private-marker"),
    ],
)
def test_invalid_darwin_probe_never_analyzes(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    monkeypatch: pytest.MonkeyPatch,
    probe: tuple[int | None, str, str],
) -> None:
    module, _, output = owned_eslint_scan
    calls = []

    def native_execute(args: list[str], cwd: Path) -> tuple[int | None, str, str]:
        calls.append(args)
        return probe

    monkeypatch.setattr(module, "native_execute", native_execute)
    assert module.main() == 1
    assert json.loads(output.read_text())["native"]["status"] == "incomplete"
    assert calls == [["/usr/bin/clang", "--version"]]
    assert "private-marker" not in output.read_text()


@pytest.fixture
def owned_windows_scan(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[ModuleType, Path, list[tuple[list[str], Path]]]:
    """Synthetic SARIF/tool policy double; this never executes or certifies Windows."""
    module, _, output = owned_eslint_scan
    tools = module.ROOT / "installed-vc"
    binary = tools / "bin/Hostx64/x64/cl.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"owned installed compiler policy double")
    (binary.parent / "link.exe").write_bytes(b"owned unused linker policy double")
    monkeypatch.setattr(module.sys, "platform", "win32")
    monkeypatch.setattr(module.os, "name", "nt")
    monkeypatch.setattr(module.os, "fstat", os.fstat, raising=False)
    monkeypatch.setattr(
        module.os,
        "environ",
        {
            "VCTOOLSINSTALLDIR": str(tools),
            "VSCMD_ARG_HOST_ARCH": "x64",
            "VSCMD_ARG_TGT_ARCH": "x64",
            "INCLUDE": "owned include",
            "LIB": "owned lib",
        },
        raising=False,
    )
    packet = {
        "version": "2.1.0",
        "runs": [{"tool": {"driver": {"name": "Microsoft C/C++ Code Analysis"}}, "results": []}],
    }
    monkeypatch.setattr(module, "analyzer_packet", packet, raising=False)
    calls: list[tuple[list[str], Path]] = []

    def native_execute(args: list[str], cwd: Path) -> tuple[int, str, str]:
        calls.append((args, cwd))
        assert args[0] == str(binary)
        assert cwd != module.ROOT and cwd.is_dir()
        if args[1:] == ["/?"]:
            return (
                0,
                "",
                "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35220 for x64\n"
                "Copyright (C) Microsoft Corporation. All rights reserved.\n",
            )
        assert args[1:10] == [
            "/nologo",
            "/W4",
            "/WX",
            "/O2",
            "/TC",
            "/c",
            "/analyze",
            "/analyze:log",
            str(cwd / "analysis.sarif"),
        ]
        assert args[10:] == [
            str(module.ROOT / "extension/native/owned.c"),
            "/Fo:" + str(cwd / "analysis.obj"),
        ]
        (cwd / "analysis.sarif").write_text(json.dumps(module.analyzer_packet))
        return 0, "owned.c\n", ""

    monkeypatch.setattr(module, "native_execute", native_execute)
    return module, output, calls


def test_windows_complete_synthetic_sarif_passes_actual_scan_and_main(
    owned_windows_scan: tuple[ModuleType, Path, list[tuple[list[str], Path]]],
) -> None:
    module, output, calls = owned_windows_scan
    assert module.main() == 0
    packet = json.loads(output.read_text())
    assert packet["native"]["status"] == "pass"
    assert len(calls) == 2
    assert all(row.get("status") not in {"incomplete", "violations"} for row in packet.values())


@pytest.mark.parametrize(
    "damage",
    [
        "missing_tool",
        "relative_install",
        "wrong_host",
        "wrong_target",
        "missing_include",
        "failed",
        "null",
        "empty",
        "malformed",
        "x86",
        "nul",
        "diagnostic",
        "spawn",
        "timeout",
        "overflow",
    ],
)
def test_windows_invalid_prerequisite_stops_before_analysis(
    owned_windows_scan: tuple[ModuleType, Path, list[tuple[list[str], Path]]],
    monkeypatch: pytest.MonkeyPatch,
    damage: str,
) -> None:
    module, output, calls = owned_windows_scan
    good: Callable[[list[str], Path], tuple[int, str, str]] = module.native_execute
    compiler = Path(module.os.environ["VCTOOLSINSTALLDIR"]) / "bin/Hostx64/x64/cl.exe"
    if damage == "missing_tool":
        compiler.unlink()
    elif damage == "relative_install":
        module.os.environ["VCTOOLSINSTALLDIR"] = "relative"
    elif damage in {"wrong_host", "wrong_target", "missing_include"}:
        key = {
            "wrong_host": "VSCMD_ARG_HOST_ARCH",
            "wrong_target": "VSCMD_ARG_TGT_ARCH",
            "missing_include": "INCLUDE",
        }[damage]
        module.os.environ[key] = "x86" if damage != "missing_include" else ""
    else:

        def execute(args: list[str], cwd: Path) -> tuple[int | None, str, str]:
            assert args[1:] == ["/?"]
            result = good(args, cwd)
            if damage in {"spawn", "timeout", "overflow"}:
                # Native runner maps these bounded process failures to this fixed result.
                return -1, "", ""
            if damage == "failed":
                return 1, result[1], result[2]
            if damage == "null":
                return None, result[1], result[2]
            if damage == "empty":
                return 0, "", ""
            if damage == "malformed":
                return 0, "private-marker", ""
            if damage == "x86":
                return 0, result[1], result[2].replace("x64", "x86")
            if damage == "nul":
                return 0, "\x00", result[2]
            return 0, "cl : warning D9002: private-marker", result[2]

        monkeypatch.setattr(module, "native_execute", execute)
    assert module.main() == 1
    assert json.loads(output.read_text())["native"]["status"] == "incomplete"
    assert all(args[1:] == ["/?"] for args, _ in calls)
    assert "private-marker" not in output.read_text()


def test_windows_help_text_and_crlf_are_valid_identity(
    owned_windows_scan: tuple[ModuleType, Path, list[tuple[list[str], Path]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, _, _ = owned_windows_scan
    good: Callable[[list[str], Path], tuple[int, str, str]] = module.native_execute

    def execute(args: list[str], cwd: Path) -> tuple[int, str, str]:
        code, out, err = good(args, cwd)
        if args[1:] == ["/?"]:
            return code, "/W4 warnings /WX treat warnings as errors\r\n", err.replace("\n", "\r\n")
        return code, out, err

    monkeypatch.setattr(module, "native_execute", execute)
    assert module.main() == 0


@pytest.mark.parametrize(
    "damage",
    [
        "missing",
        "empty",
        "oversized",
        "invalid_json",
        "duplicate",
        "nonfinite",
        "overflow_number",
        "bom",
        "symlink",
        "directory",
        "drift",
        "stdout",
        "stderr",
        "nonzero",
        "null",
        "source_drift",
        "tool_drift",
        "root_list",
        "version",
        "runs_missing",
        "runs_empty",
        "runs_many",
        "run_type",
        "driver_missing",
        "driver_name",
        "results_missing",
        "results_null",
        "results_type",
        "finding",
        "suppressed_finding",
        "inline_external",
        "root_external",
        "run_external",
        "invocations_type",
        "invocation_type",
        "execution_false",
        "execution_missing",
        "execution_number",
        "start_failure",
        "exit_code",
        "exit_code_bool",
        "signal",
        "notifications",
        "notifications_malformed",
        "configuration_notifications",
    ],
)
def test_windows_sarif_and_both_streams_fail_closed(
    owned_windows_scan: tuple[ModuleType, Path, list[tuple[list[str], Path]]],
    monkeypatch: pytest.MonkeyPatch,
    damage: str,
) -> None:
    module, output, calls = owned_windows_scan
    good: Callable[[list[str], Path], tuple[int, str, str]] = module.native_execute
    packet = module.analyzer_packet
    run = packet["runs"][0]
    if damage == "root_list":
        monkeypatch.setattr(module, "analyzer_packet", [])
    elif damage == "version":
        packet["version"] = "2.0.0"
    elif damage == "runs_missing":
        del packet["runs"]
    elif damage == "runs_empty":
        packet["runs"] = []
    elif damage == "runs_many":
        packet["runs"] = [run, run]
    elif damage == "run_type":
        packet["runs"] = [None]
    elif damage == "driver_missing":
        run["tool"] = {}
    elif damage == "driver_name":
        run["tool"]["driver"]["name"] = ""
    elif damage == "results_missing":
        del run["results"]
    elif damage in {"results_null", "results_type"}:
        run["results"] = None if damage == "results_null" else {}
    elif damage in {"finding", "suppressed_finding"}:
        run["results"] = [
            {
                "ruleId": "C6001",
                "level": "note",
                "message": {"text": "private-marker"},
                "suppressions": [{"kind": "inSource", "status": "accepted"}],
            }
        ]
    elif damage == "inline_external":
        packet["inlineExternalProperties"] = []
    elif damage == "root_external":
        packet["externalPropertyFileReferences"] = {}
    elif damage == "run_external":
        run["externalPropertyFileReferences"] = {}
    elif damage == "invocations_type":
        run["invocations"] = {}
    elif damage == "invocation_type":
        run["invocations"] = [None]
    elif damage.startswith("execution_"):
        run["invocations"] = [
            {}
            if damage == "execution_missing"
            else {"executionSuccessful": False if damage == "execution_false" else 1}
        ]
    elif damage in {
        "start_failure",
        "exit_code",
        "exit_code_bool",
        "signal",
        "notifications",
        "notifications_malformed",
        "configuration_notifications",
    }:
        key, value = {
            "start_failure": ("processStartFailureMessage", "private-marker"),
            "exit_code": ("exitCode", 1),
            "exit_code_bool": ("exitCode", False),
            "signal": ("exitSignalNumber", 9),
            "notifications": (
                "toolExecutionNotifications",
                [{"message": {"text": "private-marker"}}],
            ),
            "notifications_malformed": ("toolExecutionNotifications", {}),
            "configuration_notifications": (
                "toolConfigurationNotifications",
                [{"message": {"text": "private-marker"}}],
            ),
        }[damage]
        run["invocations"] = [{"executionSuccessful": True, key: value}]

    def execute(args: list[str], cwd: Path) -> tuple[int | None, str, str]:
        result = good(args, cwd)
        if args[1:] == ["/?"]:
            return result
        report = cwd / "analysis.sarif"
        if damage == "missing":
            report.unlink()
        elif damage in {
            "empty",
            "oversized",
            "invalid_json",
            "duplicate",
            "nonfinite",
            "overflow_number",
            "bom",
        }:
            report.write_bytes(
                {
                    "empty": b"",
                    "oversized": b"x" * (256 * 1024 + 1),
                    "invalid_json": b"private-marker",
                    "duplicate": report.read_bytes().replace(
                        b'"version": "2.1.0"', b'"version":"2.1.0","version":"2.1.0"'
                    ),
                    "overflow_number": report.read_bytes().replace(
                        b'"version":', b'"number":1e999,"version":'
                    ),
                    "nonfinite": report.read_bytes().replace(
                        b'"version":', b'"number":NaN,"version":'
                    ),
                    "bom": b"\xef\xbb\xbf" + report.read_bytes(),
                }[damage]
            )
        elif damage in {"symlink", "directory"}:
            raw = report.read_bytes()
            report.unlink()
            if damage == "symlink":
                target = cwd / "outside.sarif"
                target.write_bytes(raw)
                report.symlink_to(target)
            else:
                report.mkdir()
        elif damage == "drift":

            def fstat(fd: int) -> os.stat_result:
                info = os.fstat(fd)
                report.write_text("private-marker")
                return info

            monkeypatch.setattr(module.os, "fstat", fstat)
        elif damage in {"stdout", "stderr"}:
            return (
                0,
                "private-marker" if damage == "stdout" else "",
                "private-marker" if damage == "stderr" else "",
            )
        elif damage in {"nonzero", "null"}:
            return 1 if damage == "nonzero" else None, "", ""
        elif damage == "source_drift":
            (module.ROOT / "extension/native/owned.c").write_text("private-marker")
        elif damage == "tool_drift":
            Path(args[0]).write_text("private-marker")
        return result

    monkeypatch.setattr(module, "native_execute", execute)
    assert module.main() == 1
    assert json.loads(output.read_text())["native"]["status"] == "incomplete"
    assert len(calls) == 2
    assert "private-marker" not in output.read_text()


def test_windows_optional_successful_invocation_accepts_harmless_metadata(
    owned_windows_scan: tuple[ModuleType, Path, list[tuple[list[str], Path]]],
) -> None:
    module, _, _ = owned_windows_scan
    module.analyzer_packet["$schema"] = "https://example.invalid/never-fetch"
    module.analyzer_packet["runs"][0]["invocations"] = [
        {
            "executionSuccessful": True,
            "exitCode": 0,
            "toolExecutionNotifications": [],
            "toolConfigurationNotifications": [],
        }
    ]
    assert module.main() == 0


@pytest.mark.parametrize(
    "analysis", [(1, "", ""), (None, "", ""), (0, "private-marker", ""), (0, "", "private-marker")]
)
def test_darwin_analysis_requires_success_and_both_clean_streams(
    owned_eslint_scan: tuple[ModuleType, list[dict[str, object]], Path],
    monkeypatch: pytest.MonkeyPatch,
    analysis: tuple[int | None, str, str],
) -> None:
    module, _, output = owned_eslint_scan
    good: Callable[[list[str], Path], tuple[int, str, str]] = module.native_execute

    def execute(args: list[str], cwd: Path) -> tuple[int | None, str, str]:
        return good(args, cwd) if "--version" in args else analysis

    monkeypatch.setattr(module, "native_execute", execute)
    assert module.main() == 1
    assert json.loads(output.read_text())["native"]["status"] == "incomplete"
    assert "private-marker" not in output.read_text()


def test_native_process_forces_same_owned_child_after_grace_period(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io

    module = load()
    operations: list[tuple[str, int]] = []

    class Child:
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            operations.append(("terminate", 0))

        def kill(self) -> None:
            operations.append(("kill", 0))

        def wait(self, timeout: int) -> int:
            operations.append(("wait", timeout))
            if timeout == 2:
                raise subprocess.TimeoutExpired("owned-child", timeout)
            self.returncode = -9
            return -9

    child = Child()
    monkeypatch.setattr(module.subprocess, "Popen", lambda *args, **kwargs: child)
    clock = iter([0, 31])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    assert module.native_execute(["owned-child"], tmp_path) == (-1, "", "")
    assert operations == [("terminate", 0), ("wait", 2), ("kill", 0), ("wait", 3)]
