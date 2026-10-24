"""Copy only selected platform resources, preserving vendor bytes and POSIX links."""

import hashlib
import importlib.metadata
import json
import os
import shutil
import sqlite3
import ssl
import stat
import subprocess
import sys
import sysconfig
import threading
from io import BufferedReader
from pathlib import Path
from typing import cast

from sage.providers.protected_auth import EXECUTABLE_HASHES, EXECUTABLE_SIZES, platform_key
from scripts.package_manifest import inventory, validate_sources

ROOT = Path(__file__).resolve().parents[1]


MAX_EXTENSION_BYTES = 2_097_152


def extension_bytes(path: Path) -> bytes:
    if path != path.resolve() or any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Unsafe extension path")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("Unsafe extension path")
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= MAX_EXTENSION_BYTES:
            raise ValueError("Invalid extension size")
        content = source.read(MAX_EXTENSION_BYTES + 1)
        after = os.fstat(source.fileno())
        current = path.lstat()

    def identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    if (
        len(content) != before.st_size
        or identity(before) != identity(after)
        or identity(before) != identity(current)
    ):
        raise ValueError("Extension changed during read")
    return content


def check_extension(root: Path) -> str:
    # One closed checker process; cap combined output while it is running.
    output = bytearray()
    with subprocess.Popen(
        [
            "node",
            str(root / "scripts/check_extension.mjs"),
            str(root / ".cache/sage-editor-bridge.vsix"),
        ],
        cwd=root,
        shell=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ) as child:
        assert child.stdout is not None

        def drain() -> None:
            assert child.stdout is not None
            while chunk := cast(BufferedReader, child.stdout).read1(4096):
                output.extend(chunk[: 16_385 - len(output)])
                if len(output) > 16_384:
                    child.kill()
                    break

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            code = child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
            raise ValueError("Extension checker timeout") from None
        finally:
            reader.join(timeout=5)
        if reader.is_alive() or code != 0 or len(output) > 16_384:
            raise ValueError("Extension checker failed")
    result = json.loads(output.decode("utf-8", errors="strict"))
    if (
        not isinstance(result, dict)
        or set(result) != {"status", "entries", "sha256", "bundleSha256"}
        or result["status"] != "pass"
        or not isinstance(result["entries"], list)
        or not 1 <= len(result["entries"]) <= 16
        or any(not isinstance(name, str) or not 1 <= len(name) <= 256 for name in result["entries"])
        or any(
            not isinstance(result[key], str)
            or len(result[key]) != 64
            or any(character not in "0123456789abcdef" for character in result[key])
            for key in ("sha256", "bundleSha256")
        )
    ):
        raise ValueError("Invalid extension checker record")
    return str(result["sha256"])


def stage_editor_extension(root: Path) -> None:
    source = root / ".cache/sage-editor-bridge.vsix"
    target_root = root / ".runtime/package/editor-extension"
    descriptor = root / "build/editor-extension.json"
    manifest = root / "build/resource-manifest.json"
    if (
        target_root.exists()
        or target_root.is_symlink()
        or descriptor.exists()
        or descriptor.is_symlink()
        or manifest.exists()
        or manifest.is_symlink()
    ):
        raise ValueError("Extension stage already exists")
    expected = check_extension(root)
    content = extension_bytes(source)
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError("Extension changed after strict check")
    for directory in (target_root.parent, descriptor.parent):
        if directory != directory.resolve() or not directory.is_dir():
            raise ValueError("Unsafe extension stage")
    target_root.mkdir()
    target = target_root / "sage-editor-bridge.vsix"
    with target.open("xb") as output:
        output.write(content)
    copied = extension_bytes(target)
    digest = hashlib.sha256(copied).hexdigest()
    if copied != content or digest != expected:
        raise ValueError("Extension copy changed")
    value = {"schema": 1, "platform": platform_key(), "bytes": len(copied), "sha256": digest}
    if value["platform"] not in {"darwin-arm64", "win32-x64"}:
        raise ValueError("Unsupported extension platform")
    with descriptor.open("x", encoding="utf-8") as output:
        output.write(json.dumps(value, separators=(",", ":")) + "\n")


def verified_copy(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_dir() or target.exists():
        raise ValueError("Invalid native staging")
    # inventory() also rejects escapes; its core requirement is checked at final scope.
    shutil.copytree(source, target, symlinks=True)
    for path in source.rglob("*"):
        if path.is_symlink():
            if not path.resolve().is_relative_to(source.resolve()):
                raise ValueError("Native staging link escape")
            if os.readlink(path) != os.readlink(target / path.relative_to(source)):
                raise ValueError("Native staging link changed")
        elif path.is_file():
            copied = target / path.relative_to(source)
            if path.read_bytes() != copied.read_bytes():
                raise ValueError("Native staging bytes changed")


def copy_javascript_notices(root: Path, destination: Path) -> None:
    lock = json.loads((root / "package-lock.json").read_text())
    for name, metadata in lock["packages"].items():
        if not name or metadata.get("dev", False):
            continue
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or not name.startswith("node_modules/"):
            raise ValueError("Invalid production dependency path")
        source = root / relative
        if source.is_symlink() or not source.resolve().is_relative_to(
            (root / "node_modules").resolve()
        ):
            raise ValueError("Invalid production dependency root")
        licenses = [
            path
            for path in source.iterdir()
            if path.is_file() and path.name.lower().startswith(("license", "copying", "notice"))
        ]
        if not licenses or any(path.is_symlink() for path in licenses):
            raise ValueError("Missing production JavaScript notice")
        target = destination / relative.relative_to("node_modules")
        target.mkdir(parents=True, exist_ok=True)
        for path in licenses:
            shutil.copyfile(path, target / path.name)


def electron_component_versions(root: Path) -> dict[str, str]:
    # Inspect the pristine locked vendor distribution, before Forge flips fuses.
    # The shipped app never enables RunAsNode or an inspector for diagnostics.
    relative = {
        "darwin": "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "win32": "node_modules/electron/dist/electron.exe",
    }.get(sys.platform, "node_modules/electron/dist/electron")
    environment = {"ELECTRON_RUN_AS_NODE": "1", "LANG": "C.UTF-8"}
    for key in ("SystemRoot", "WINDIR"):
        if key in os.environ:
            environment[key] = os.environ[key]
    result = subprocess.run(
        [str(root / relative), "-e", "process.stdout.write(JSON.stringify(process.versions))"],
        cwd=root,
        env=environment,
        capture_output=True,
        check=True,
        timeout=10,
    )
    reported = json.loads(result.stdout)
    names = ("electron", "chrome", "node", "v8")
    if (
        not isinstance(reported, dict)
        or reported.get("electron") != "45.0.0"
        or not all(
            isinstance(reported.get(name), str) and 0 < len(reported[name]) <= 100 for name in names
        )
    ):
        raise ValueError("Unexpected vendor engine version record")
    return {name: str(reported[name]) for name in names}


def main() -> int:
    package = ROOT / ".runtime/package"
    stage_editor_extension(ROOT)
    core_baseline = json.loads((ROOT / "build/core-manifest.json").read_text())["entries"]
    actual_core = {
        name: row for name, row in inventory(package).items() if name.startswith("core/")
    }
    if actual_core != core_baseline:
        raise ValueError("Frozen core inventory changed before staging")
    key = platform_key()
    source_rows = json.loads((ROOT / ".runtime/native-source-inventory.json").read_text())
    validate_sources(ROOT / ".runtime", source_rows)
    if key not in EXECUTABLE_HASHES:
        raise ValueError("Unsupported native platform")
    runtime = ROOT / ".runtime/copilot/1.0.102"
    platform_tree = runtime / "prebuilds" / key
    wrapper = "copilot-runtime.exe" if os.name == "nt" else "copilot-runtime"
    for name in [wrapper, "runtime.node", ".hostless-runtime-assets-v2"]:
        if not (platform_tree / name).is_file():
            raise ValueError("Incomplete native runtime")
    gh = ROOT / ".runtime/gh/2.103.0" / key
    executable = gh / "bin" / ("gh.exe" if os.name == "nt" else "gh")
    if (
        executable.stat().st_size != EXECUTABLE_SIZES[key]
        or hashlib.sha256(executable.read_bytes()).hexdigest() != EXECUTABLE_HASHES[key]
    ):
        raise ValueError("Unexpected official gh bytes")
    verified_copy(platform_tree, package / "copilot/1.0.102/prebuilds" / key)
    verified_copy(runtime / "notices", package / "copilot/1.0.102/notices")
    verified_copy(gh, package / "gh/2.103.0" / key)
    notices = package / "notices"
    notices.mkdir()
    # Keep host/runtime notices outside ASAR alongside exact deployed resources.
    sdk_license = ROOT / "docs/third-party/github-copilot-sdk-1.0.25-LICENSE.txt"
    if hashlib.sha256(sdk_license.read_bytes()).hexdigest() != (
        "2510b446bc1f0cf9702453075d20cd88631e20e5642658edb7325d9c1eb534f7"
    ):
        raise ValueError("Unexpected SDK notice")
    sdk_notice = notices / "github-copilot-sdk/LICENSE"
    sdk_notice.parent.mkdir()
    shutil.copyfile(sdk_license, sdk_notice)
    for name in ("LICENSE", "LICENSES.chromium.html"):
        target = notices / "electron" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "node_modules/electron/dist" / name, target)
    python_license = Path(sysconfig.get_path("stdlib")) / "LICENSE.txt"
    if not python_license.is_file():
        python_license = Path(sys.base_prefix) / "LICENSE.txt"
    shutil.copyfile(python_license, notices / "CPython-LICENSE.txt")
    pyinstaller = importlib.metadata.distribution("pyinstaller")
    for file in pyinstaller.files or []:
        if ".dist-info" in str(file) and "license" in str(file).lower():
            target = notices / "pyinstaller" / Path(file).name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(pyinstaller.locate_file(file)), target)
    npm = "npm.cmd" if os.name == "nt" else "npm"
    js_bom = subprocess.run(
        [npm, "sbom", "--omit=dev", "--sbom-format=cyclonedx"],
        cwd=ROOT,
        capture_output=True,
        check=True,
    )
    json.loads(js_bom.stdout)
    (notices / "javascript-sbom.cdx.json").write_bytes(js_bom.stdout)
    (notices / "native-source-inventory.json").write_text(json.dumps(source_rows, indent=2) + "\n")
    native_bom = {
        "schema": 1,
        "platform": key,
        "python": sys.version,
        "openssl": ssl.OPENSSL_VERSION,
        "sqlite": sqlite3.sqlite_version,
        "electron": "45.0.0",
        "electron_components": electron_component_versions(ROOT),
        "copilot_sdk": "1.0.25",
        "copilot_native": "1.0.102",
        "gh": "2.103.0",
        "native_license_review": "incomplete",
        "native_cve_scan": "not covered by pip/npm advisories",
        "build_tools": {"PyInstaller": "6.22.3", "hooks": "2026.9", "Forge": "8.0.1"},
    }
    (notices / "native-sbom.json").write_text(json.dumps(native_bom, indent=2) + "\n")
    copy_javascript_notices(ROOT, notices / "javascript")
    distributions = []
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        # Runtime metadata was selected by the spec, so build tools aren't release dependencies.
        metadata_dirs = list((package / "core/_internal").glob("*.dist-info"))
        canonical = name.lower().replace("-", "_")
        if not any(path.name.lower().startswith(canonical + "-") for path in metadata_dirs):
            continue
        distributions.append(
            {
                "name": name,
                "version": dist.version,
                "license": dist.metadata.get("License-Expression") or dist.metadata.get("License"),
            }
        )
        for file in dist.files or []:
            if ".dist-info" in str(file) and any(
                word in str(file).lower() for word in ["license", "notice", "copying"]
            ):
                target = notices / name / Path(file).name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(str(dist.locate_file(file)), target)
    sbom = {
        "schema": 1,
        "scope": "Frozen Python runtime dependencies; native inventory is separate",
        "packages": sorted(distributions, key=lambda row: str(row["name"])),
    }
    (notices / "python-sbom.json").write_text(json.dumps(sbom, indent=2) + "\n")
    manifest = {"schema": 1, "entries": inventory(package)}
    (ROOT / "build/resource-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("PASS selected native resources staged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
