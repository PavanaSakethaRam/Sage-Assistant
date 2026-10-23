"""Reject retired execution paths in the checkout and actual built artifacts.

Reintroducing a legacy launcher, dependency, import or credential sample must
fail here before it can be packaged. Scanner diagnostics contain locations only.
"""

import ast
import json
import re
import subprocess
import sys
import tomllib
import zipfile
from collections.abc import Mapping
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RETIRED = (
    "main.py",
    "example.py",
    "config.json",
    "requirements.txt",
    "modules",
    "templates/send_button.png",
    "test.png",
    "test.py",
)
FORBIDDEN = {
    "modules",
    "pywinauto",
    "selenium",
    "pytesseract",
    "opencv-python",
    "cv2",
    "pillow",
    "pil",
    "pyttsx3",
    "spacy",
    "scikit-learn",
    "sklearn",
    "numpy",
    "pandas",
    "sounddevice",
    "pyaudio",
    "pvporcupine",
    "openai-whisper",
    "whisper",
    "argostranslate",
    "resemblyzer",
    "speechrecognition",
    "pyautogui",
    "keyboard",
    "pynput",
    "pywhatkit",
}
UNSAFE_PATHS = re.compile(
    r"\b(?:modules\.|voice_auth|admin_override|admin_embedding|type_keys|send_keys|SendInput)\b"
)
IMPORT = re.compile(r"(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)[\"']([^\"']+)[\"']")
SECRET_PATTERNS = {
    "github_token": re.compile(r"\bgh[opusr]_[A-Za-z0-9]{20,}\b"),
    "github_fine_grained": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    "api_key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "google_key": re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "literal_credential": re.compile(
        r"(?i)[\"']?(?:access_key|api_key|password|client_secret|auth_token|github_token)"
        r"[\"']?\s*[:=]\s*[\"'][^\"'\r\n]{12,}[\"']"
    ),
}


def redacted_findings(files: Mapping[str, str]) -> list[str]:
    """Only paths, line numbers and rule names leave the scan."""
    return [
        f"{path}:{text.count(chr(10), 0, match.start()) + 1}:{kind}:[REDACTED]"
        for path, text in sorted(files.items())
        for kind, pattern in SECRET_PATTERNS.items()
        for match in pattern.finditer(text)
    ]


def normalized(name: str) -> str:
    return name.lower().replace("_", "-")


def assert_safe_text(name: str, text: str) -> None:
    assert not UNSAFE_PATHS.search(text), f"Retired execution path in {name}"
    for specifier in IMPORT.findall(text):
        package = specifier.split("/")[0].split(".")[0]
        assert normalized(package) not in FORBIDDEN, f"Retired import in {name}"


def test_retired_launchers_and_credential_samples_are_absent() -> None:
    remaining = [path for path in RETIRED if (ROOT / path).exists()]
    assert remaining == [], f"Retired release surface remains: {remaining}"


def test_maintained_imports_cannot_reach_legacy_automation() -> None:
    for path in (ROOT / "src/sage").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(text)):
            names = (
                [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else []
            )
            for name in names:
                assert normalized(name.split(".")[0]) not in FORBIDDEN, str(path)
        assert_safe_text(str(path.relative_to(ROOT)), text)
    for path in (ROOT / "desktop").rglob("*"):
        if path.suffix in {".ts", ".tsx"} and "tests" not in path.parts:
            assert_safe_text(str(path.relative_to(ROOT)), path.read_text(encoding="utf-8"))


def test_locked_dependency_graphs_exclude_original_packages() -> None:
    locked = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    python_names = {normalized(package["name"]) for package in locked["package"]}
    npm = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    node_names = {
        normalized(name.rsplit("node_modules/", 1)[-1]) for name in npm["packages"] if name
    }
    assert not (python_names | node_names) & FORBIDDEN


@pytest.fixture(scope="module")
def release_artifacts(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    output = tmp_path_factory.mktemp("release-surface")
    commands = [[sys.executable, "-m", "hatchling", "build", "-t", "wheel", "-d", str(output)]]
    for target in ("main", "preload", "renderer"):
        commands.append(
            [
                "node",
                str(ROOT / "node_modules/vite/bin/vite.js"),
                "build",
                "--config",
                f"vite.{target}.config.ts",
                "--outDir",
                str(output / target),
            ]
        )
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=60, check=False)
        if result.returncode != 0:
            pytest.fail("Release artifact build failed", pytrace=False)
    files = {}
    wheels = list(output.glob("*.whl"))
    assert len(wheels) == 1
    with zipfile.ZipFile(wheels[0]) as wheel:
        for name in wheel.namelist():
            assert name.startswith(("sage/", "sage_assistant-0.1.0.dist-info/")), name
            files["wheel/" + name] = wheel.read(name).decode("utf-8")
    for target in ("main", "preload", "renderer"):
        built = [path for path in (output / target).rglob("*") if path.is_file()]
        assert built, f"Missing {target} artifact"
        for path in built:
            files[str(path.relative_to(output))] = path.read_text(encoding="utf-8")
    return files


def test_actual_wheel_and_desktop_bundles_exclude_legacy_and_secrets(
    release_artifacts: dict[str, str],
) -> None:
    findings = redacted_findings(release_artifacts)
    if findings:
        # A normal assertion traceback would display the raw artifact argument.
        pytest.fail("Credential patterns in artifacts:\n" + "\n".join(findings), pytrace=False)
    for name, text in release_artifacts.items():
        assert_safe_text(name, text)
        if any(
            marker in text
            for marker in (
                "e2e/fixtures",
                "__sageE2E",
                "FakeReasoner",
                "events.jsonl",
                "full.once",
                "egress_probe",
            )
        ):
            pytest.fail("Test-only composition in production artifact", pytrace=False)
        assert not any(
            part in {"modules", "credentials.json", ".env", "test.py", "config.json"}
            for part in Path(name).parts
        ), f"Credential/legacy sample in {name}"


def test_secret_scan_reports_synthetic_markers_without_their_values() -> None:
    token = "gho_" + "SYNTHETIC" * 5
    password = "SYNTHETIC-" * 4
    findings = redacted_findings({"sample.py": f'token = "{token}"\npassword = "{password}"'})
    assert findings == [
        "sample.py:1:github_token:[REDACTED]",
        "sample.py:2:literal_credential:[REDACTED]",
    ]
    assert token not in "\n".join(findings)
    assert password not in "\n".join(findings)
    assert redacted_findings({"clean.py": 'token = token_source()\npassword = ""'}) == []


@pytest.mark.parametrize("failure_path", ["content", "build"])
def test_artifact_scan_failure_does_not_expose_content_in_pytest_output(
    tmp_path: Path, failure_path: str
) -> None:
    marker = "gho_" + "SYNTHETIC" * 5
    probe = tmp_path / "test_redacted_failure.py"
    probe.write_text(
        "import sys\n"
        "import pytest\n"
        "from subprocess import CompletedProcess\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        "pytest.register_assert_rewrite('tests.security.test_release_surface')\n"
        "from tests.security import test_release_surface as suite\n"
        "def test_synthetic_artifact(tmp_path_factory, monkeypatch):\n"
        "    marker = 'gho_' + 'SYNTHETIC' * 5\n"
        f"    if {failure_path!r} == 'content':\n"
        "        suite.test_actual_wheel_and_desktop_bundles_exclude_legacy_and_secrets(\n"
        "            {'wheel/sage/example.py': 'token = ' + repr(marker)})\n"
        "    else:\n"
        "        def failed_build(command, **kwargs):\n"
        "            return CompletedProcess(command, 1, stdout=marker.encode(), "
        "stderr=marker.encode())\n"
        "        monkeypatch.setattr(suite.subprocess, 'run', failed_build)\n"
        "        suite.release_artifacts.__wrapped__(tmp_path_factory)\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(probe)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 1
    assert marker not in result.stdout + result.stderr
    diagnostic = "[REDACTED]" if failure_path == "content" else "Release artifact build failed"
    assert diagnostic in result.stdout
