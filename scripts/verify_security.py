"""Complete locked dependency/static/secret scans; persist only allowlisted metadata."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
UV = ROOT / ".venv" / ("Scripts/uv.exe" if os.name == "nt" else "bin/uv")
NPM = "npm.cmd" if os.name == "nt" else "npm"
GITLEAKS = ROOT / ".cache/tooling" / ("gitleaks.exe" if os.name == "nt" else "gitleaks")


def execute(
    args: list[str], cwd: Path = ROOT, environment: dict[str, str] | None = None
) -> tuple[int, Any, str]:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
            env={
                **os.environ,
                "UV_CACHE_DIR": str(ROOT / ".cache/uv"),
                "npm_config_cache": str(ROOT / ".cache/npm"),
                **(environment or {}),
            },
        )
        try:
            data = json.loads(result.stdout)
        except ValueError:
            data = None
        return result.returncode, data, result.stderr
    except (OSError, subprocess.TimeoutExpired):
        return -1, None, "execution_failed"


def collect_bandit(targets: list[str]) -> tuple[int, Any, str]:
    # Stevedore uses HOME on macOS and LOCALAPPDATA on Windows. Only this
    # scanner child gets an owned home; no user cache/configuration is touched.
    tool_home = ROOT / ".cache/bandit-home"
    tool_home.mkdir(parents=True, exist_ok=True)
    return execute(
        [
            sys.executable,
            "-m",
            "bandit",
            "--recursive",
            *targets,
            "--format",
            "json",
            "--ignore-nosec",
            "--quiet",
        ],
        environment={
            "HOME": str(tool_home),
            "USERPROFILE": str(tool_home),
            "LOCALAPPDATA": str(tool_home / "local"),
            "XDG_CACHE_HOME": str(tool_home / "cache"),
        },
    )


def secret_result(code: int, data: Any, diagnostics: str) -> dict[str, Any]:
    if (
        code not in {0, 2}
        or not isinstance(data, list)
        or re.search(r"warn|error|skip|denied", diagnostics, re.I)
    ):
        return {"status": "incomplete", "reason": "secret collection failed"}
    findings = []
    for item in data:
        if not isinstance(item, dict) or not all(
            k in item for k in ("RuleID", "File", "StartLine")
        ):
            return {"status": "incomplete", "reason": "invalid secret schema"}
        findings.append(
            {
                "rule": item["RuleID"],
                "path": (
                    str(Path(item["File"]).relative_to(ROOT))
                    if Path(item["File"]).is_absolute() and Path(item["File"]).is_relative_to(ROOT)
                    else item["File"]
                ),
                "line": item["StartLine"],
                "triage": "untriaged",
            }
        )
    if (code == 2) != bool(findings):
        return {"status": "incomplete", "reason": "secret status mismatch"}
    return {"status": "violations" if findings else "pass", "findings": findings}


def python_result(code: int, data: Any, inventory: dict[str, str]) -> dict[str, Any]:
    if (
        code not in {0, 1}
        or not isinstance(data, dict)
        or not isinstance(data.get("dependencies"), list)
    ):
        return {"status": "incomplete", "reason": "Python collection failed"}
    entries = data["dependencies"]
    if not inventory or not all(isinstance(e, dict) for e in entries):
        return {"status": "incomplete", "reason": "invalid Python inventory"}

    def normalize(name: str) -> str:
        return re.sub(r"[-_.]+", "-", name).lower()

    seen = {
        normalize(e.get("name", "")): e.get("version") for e in entries if not e.get("skip_reason")
    }
    if seen != inventory or any(not isinstance(e.get("vulns"), list) for e in entries):
        return {"status": "incomplete", "reason": "Python locked inventory mismatch"}
    findings = [
        {
            "package": e["name"],
            "version": e["version"],
            "advisory": v["id"],
            "aliases": v.get("aliases", []),
            "severity": "unresolved",
            "triage": "untriaged",
        }
        for e in entries
        for v in e["vulns"]
    ]
    if (code == 1) != bool(findings):
        return {"status": "incomplete", "reason": "Python audit status mismatch"}
    return {
        "status": "violations" if findings else "pass",
        "packages": len(entries),
        "inventory": inventory,
        "findings": findings,
    }


def npm_result(code: int, data: Any) -> dict[str, Any]:
    if (
        code not in {0, 1}
        or not isinstance(data, dict)
        or data.get("error")
        or data.get("auditReportVersion") != 2
        or not data.get("metadata", {}).get("dependencies", {}).get("total")
        or not isinstance(data.get("vulnerabilities"), dict)
    ):
        return {"status": "incomplete", "reason": "Node collection failed"}
    findings = [
        {"package": name, "severity": v.get("severity", "unknown"), "triage": "untriaged"}
        for name, v in data["vulnerabilities"].items()
    ]
    violation = any(v["severity"] not in {"info", "low", "moderate"} for v in findings)
    return {
        "status": "violations" if violation else "pass",
        "dependencies": data["metadata"]["dependencies"],
        "findings": findings,
    }


def scan(base: str, head: str) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for tree in ["src", "desktop", "e2e", "tests", "scripts"]:
        if any(path.is_symlink() for path in (ROOT / tree).rglob("*")):
            raise ValueError("maintained symlinks are unsupported by scanner inventory")
    node_lock = json.loads((ROOT / "package-lock.json").read_text())
    for package, version in {
        "@playwright/test": "1.64.1",
        "eslint-plugin-security": "4.2.0",
    }.items():
        if (
            node_lock["packages"]["node_modules/" + package]["version"] != version
            or json.loads((ROOT / "node_modules" / package / "package.json").read_text())["version"]
            != version
        ):
            raise ValueError("Node scanner version mismatch")
    for value in (base, head):
        if (
            not re.fullmatch(r"[0-9a-f]{40}", value)
            or subprocess.run(
                ["git", "cat-file", "-e", value + "^{commit}"],
                cwd=ROOT,
                capture_output=True,
                check=False,
            ).returncode
        ):
            raise ValueError("invalid diff commit")
    for package, version in {"bandit": "1.9.4", "pip-audit": "2.10.1", "uv": "0.13.5"}.items():
        if importlib.metadata.version(package) != version:
            raise ValueError("scanner version mismatch")
    with tempfile.TemporaryDirectory(prefix="sage-security-") as scratch:
        temp = Path(scratch)
        requirements = temp / "requirements.txt"
        code, _, _ = execute(
            [
                str(UV),
                "export",
                "--locked",
                "--all-groups",
                "--no-emit-project",
                "--format",
                "requirements.txt",
                "--output-file",
                str(requirements),
            ]
        )
        if code:
            results["python"] = {"status": "incomplete", "reason": "locked export failed"}
        else:
            # pip-audit evaluates platform markers. Match every installed all-groups lock package.
            lock = tomllib.loads((ROOT / "uv.lock").read_text())
            from packaging.markers import Marker
            from packaging.utils import canonicalize_name

            inventory: dict[str, str] = {}
            for line in requirements.read_text().splitlines():
                if not line or line[0].isspace() or line.startswith("#"):
                    continue
                match = re.match(r"([\w.-]+)==([^ ;\\]+)(?:\s*;\s*(.*?))?\s*(?:\\)?$", line)
                if not match:
                    raise ValueError("unexpected export requirement")
                name, version, marker = match.groups()
                if marker and not Marker(marker.rstrip(" \\")).evaluate():
                    continue
                if not any(
                    p["name"] == canonicalize_name(name) and p["version"] == version
                    for p in lock["package"]
                ):
                    raise ValueError("export lock mismatch")
                if importlib.metadata.version(name) != version:
                    raise ValueError("installed lock mismatch")
                inventory[canonicalize_name(name)] = version
            audited = execute(
                [
                    sys.executable,
                    "-m",
                    "pip_audit",
                    "--cache-dir",
                    str(ROOT / ".cache/pip-audit"),
                    "--progress-spinner",
                    "off",
                    "--strict",
                    "--require-hashes",
                    "--disable-pip",
                    "--requirement",
                    str(requirements),
                    "--format",
                    "json",
                ]
            )
            results["python"] = python_result(audited[0], audited[1], inventory)
            results["python"]["export_sha256"] = hashlib.sha256(
                requirements.read_bytes()
            ).hexdigest()
        npm = execute(
            [
                NPM,
                "audit",
                "--package-lock-only",
                "--include=dev",
                "--include=optional",
                "--include=peer",
                "--audit-level=high",
                "--json",
            ]
        )
        results["node"] = npm_result(npm[0], npm[1])
        targets = ["src", "tests", "scripts", "e2e", "desktop/tests/fixtures"]
        bandit = collect_bandit(targets)
        data = bandit[1]
        expected = {
            p.relative_to(ROOT).as_posix() for t in targets for p in (ROOT / t).rglob("*.py")
        }
        if (
            bandit[0] not in {0, 1}
            or not isinstance(data, dict)
            or data.get("errors")
            or not expected <= {str(Path(p).as_posix()) for p in data.get("metrics", {})}
        ):
            results["bandit"] = {
                "status": "incomplete",
                "reason": "static source inventory mismatch",
            }
        else:
            findings = [
                {
                    "rule": f["test_id"],
                    "path": f["filename"],
                    "line": f["line_number"],
                    "severity": f["issue_severity"],
                    "confidence": f["issue_confidence"],
                    "triage": "untriaged",
                }
                for f in data["results"]
            ]
            results["bandit"] = {
                "status": "violations"
                if any(f["severity"] == "HIGH" for f in findings)
                else "pass",
                "files": len(expected),
                "findings": findings,
            }
        eslint = execute(
            [
                str(ROOT / "node_modules/.bin" / ("eslint.cmd" if os.name == "nt" else "eslint")),
                ".",
                "--config",
                "eslint.security.config.mjs",
                "--format",
                "json",
            ]
        )
        data = eslint[1]
        expected_js = {
            p.resolve()
            for t in ["desktop", "e2e", "scripts"]
            for p in (ROOT / t).rglob("*")
            if p.suffix in {".ts", ".tsx", ".js", ".mjs"}
        }
        if (
            eslint[0] not in {0, 1}
            or not isinstance(data, list)
            or not expected_js <= {Path(f["filePath"]) for f in data}
            or any(f.get("errorCount") for f in data)
        ):
            results["eslint"] = {
                "status": "incomplete",
                "reason": "JavaScript static collection failed",
            }
        else:
            findings = [
                {
                    "rule": m["ruleId"],
                    "path": str(Path(f["filePath"]).relative_to(ROOT)),
                    "line": m["line"],
                    "triage": "hotspot_requires_review",
                }
                for f in data
                for m in f["messages"]
                if m.get("ruleId", "").startswith("security/")
            ]
            results["eslint"] = {"status": "pass", "files": len(data), "findings": findings}
        if (
            not GITLEAKS.exists()
            or hashlib.sha256(GITLEAKS.read_bytes()).hexdigest()
            != GITLEAKS.with_suffix(".sha256").read_text().strip()
        ):
            results["secrets"] = {"status": "incomplete", "reason": "verified scanner missing"}
        else:
            scanner_version = subprocess.run(
                [str(GITLEAKS), "version"], capture_output=True, text=True, check=False
            )
            if scanner_version.returncode or scanner_version.stdout.strip() != "8.30.1":
                raise ValueError("Gitleaks version mismatch")
            flags = [
                "--config",
                str(ROOT / ".gitleaks.toml"),
                "--redact=100",
                "--ignore-gitleaks-allow",
                "--gitleaks-ignore-path",
                str(temp / "empty-ignore"),
                "--no-banner",
                "--exit-code=2",
                "--report-format=json",
                "--report-path=-",
            ]
            (temp / "empty-ignore").mkdir()
            for label, argv in [
                ("current", ["dir", str(ROOT)]),
                ("diff", ["git", str(ROOT), f"--log-opts={base}..{head}"]),
            ]:
                results["secrets_" + label] = secret_result(
                    *execute([str(GITLEAKS), *argv, *flags])
                )
            staged = (
                subprocess.run(
                    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
                    cwd=ROOT,
                    capture_output=True,
                    check=True,
                )
                .stdout.decode()
                .split("\0")
            )
            staged = [name for name in staged if name]
            if staged:
                snapshot = temp / "staged"
                snapshot.mkdir()
                for name in staged:
                    relative = Path(name)
                    if (
                        relative.is_absolute()
                        or ".." in relative.parts
                        or (ROOT / relative).is_symlink()
                    ):
                        raise ValueError("unsupported staged path")
                    content = subprocess.run(
                        ["git", "show", ":" + name], cwd=ROOT, capture_output=True, check=True
                    ).stdout
                    target = snapshot / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                staged_result = execute([str(GITLEAKS), "dir", str(snapshot), *flags])
                if isinstance(staged_result[1], list):
                    for finding in staged_result[1]:
                        if (
                            isinstance(finding, dict)
                            and Path(finding.get("File", "")).is_absolute()
                        ):
                            finding["File"] = str(Path(finding["File"]).relative_to(snapshot))
                results["secrets_staged"] = secret_result(*staged_result)
                results["secrets_staged"]["files"] = staged
            else:
                results["secrets_staged"] = {"status": "not_applicable", "files": []}
            results["secret_scope"] = {
                "base": base,
                "head": head,
                "current_includes_untracked": True,
                "staged": "full current index contents of added/changed files; excludes deletions",
            }
            probe = temp / "probe"
            probe.mkdir()
            marker = "ghp_" + "A1b2C3d4E5" * 4
            (probe / "synthetic.txt").write_text('token="' + marker + '"')
            sensitive = execute([str(GITLEAKS), "dir", str(probe), *flags])
            checked = secret_result(*sensitive)
            results["secret_sensitivity"] = {
                "status": "pass"
                if checked["status"] == "violations" and marker not in json.dumps(sensitive[1])
                else "incomplete"
            }
    results["historical_exposure"] = {
        "status": "separate_unresolved",
        "detail": (
            "Deleted original root test.py exposure is known; no value retrieval or revocation "
            "claim; current and new diff are not history certification."
        ),
    }
    results["versions"] = {
        "python": sys.version.split()[0],
        "bandit": "1.9.4",
        "pip-audit": "2.10.1",
        "uv": "0.13.5",
        "gitleaks": "8.30.1",
    }
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "coverage/security.json")
    args = parser.parse_args()
    try:
        results = scan(args.base, args.head)
    except Exception:
        results = {
            "collection": {
                "status": "incomplete",
                "reason": "security collection failed; diagnostics suppressed",
            }
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    failed = any(r.get("status") in {"incomplete", "violations"} for r in results.values())
    print(json.dumps({"status": "failed" if failed else "pass", "report": str(args.output)}))
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
