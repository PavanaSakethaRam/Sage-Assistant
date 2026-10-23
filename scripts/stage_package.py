"""Copy only selected platform resources, preserving vendor bytes and POSIX links."""

import hashlib
import importlib.metadata
import json
import os
import shutil
import sqlite3
import ssl
import subprocess
import sys
import sysconfig
from pathlib import Path

from sage.providers.protected_auth import EXECUTABLE_HASHES, EXECUTABLE_SIZES, platform_key
from scripts.package_manifest import inventory, validate_sources

ROOT = Path(__file__).resolve().parents[1]


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
