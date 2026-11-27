"""Explicit build-time native provisioning; no native execution or account/config access."""

import hashlib
import json
import os
import stat
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

from sage.providers.protected_auth import EXECUTABLE_HASHES, platform_key

ROOT = Path(__file__).resolve().parents[1]
GH_ASSETS = {
    "darwin-arm64": (
        "macOS_arm64",
        "54be566e9f614bea5de8021e95b9ad33dfee3b9d2ea120c9c294c00defaa5014",
    ),
    "darwin-x64": (
        "macOS_amd64",
        "64d1734941f104f996271c820daa50e96902c2618f9b4c1e63c41519517a9c6b",
    ),
    "win32-arm64": (
        "windows_arm64",
        "bc8c27c396c683a7a823446fd0c16b923e60ec3fac5d26a875c646865d513a48",
    ),
    "win32-x64": (
        "windows_amd64",
        "80c846a5b8432672ca6373b34ce9de998c9686aaa1885c845f2e1ee81f713726",
    ),
}


def fetch(url: str, digest: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        data = bytes(response.read(200_000_001))
    if len(data) > 200_000_000 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Native source checksum mismatch")
    return data


def main() -> int:
    key = platform_key()
    suffix, digest = GH_ASSETS[key]
    ghroot = ROOT / ".runtime/gh/2.103.0"
    destination = ghroot / key
    runtime = ROOT / ".runtime/copilot/1.0.102"
    if destination.exists() or runtime.exists():
        raise ValueError("Preserve existing staging; use a fresh checkout for provisioning")
    artifacts = ghroot / "artifacts"
    artifacts.mkdir(parents=True)
    name = f"gh_2.103.0_{suffix}.zip"
    data = fetch("https://github.com/cli/cli/releases/download/v2.103.0/" + name, digest)
    archive_path = artifacts / name
    archive_path.write_bytes(data)
    checksums = fetch(
        "https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_checksums.txt",
        "075bb954e2b113d0d2ac788d318b516280cb87103e601e788c34f3557acb15df",
    )
    (artifacts / "gh_2.103.0_checksums.txt").write_bytes(checksums)
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Native source archive corruption")
        seen = set()
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in item.filename:
                raise ValueError("Unsafe source archive path")
            parts = path.parts
            # macOS archives have a versioned top directory; Windows archives do not.
            if parts and parts[0] == f"gh_2.103.0_{suffix}":
                parts = parts[1:]
            if not parts or item.is_dir():
                continue
            relative = PurePosixPath(*parts)
            allowed = str(relative) in {"LICENSE", "bin/gh", "bin/gh.exe"} or (
                str(relative).startswith("share/man/man1/gh") and relative.suffix == ".1"
            )
            if not allowed or stat.S_ISLNK(item.external_attr >> 16) or relative in seen:
                raise ValueError("Unexpected native source member")
            seen.add(relative)
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(item))
            if os.name != "nt":
                target.chmod((item.external_attr >> 16) & 0o777)
    executable = destination / "bin" / ("gh.exe" if os.name == "nt" else "gh")
    if hashlib.sha256(executable.read_bytes()).hexdigest() != EXECUTABLE_HASHES[key]:
        raise ValueError("Unexpected official gh executable")
    env = {key: value for key, value in os.environ.items() if not key.startswith("COPILOT_")}
    env["COPILOT_CLI_EXTRACT_DIR"] = str(runtime)
    subprocess.run(
        [sys.executable, "-I", "-m", "copilot", "download-runtime"],
        env=env,
        cwd=ROOT,
        check=True,
        timeout=900,
    )
    notices = runtime / "notices"
    notices.mkdir()
    for name, checksum in [
        ("SHA256SUMS.txt", "8753dd200b4d5c6d1989b7ffc2804b5762f9bf5a3ddee5e098aac4d78f89f4d2"),
        ("LICENSE.md", "c694e2d9b3f3bb40704ca9bdc823dc90269999ab4c013dfd8a52c407046074b4"),
    ]:
        url = (
            "https://github.com/github/copilot-cli/releases/download/v1.0.102/" + name
            if name == "SHA256SUMS.txt"
            else "https://raw.githubusercontent.com/github/copilot-cli/v1.0.102/LICENSE.md"
        )
        (notices / name).write_bytes(fetch(url, checksum))
    # Exact source inventory is build evidence, distinct from deployed-resource inventory.
    inventory = []
    for source in [destination, runtime]:
        for source_path in sorted(source.rglob("*")):
            if source_path.is_file():
                inventory.append(
                    {
                        "path": source_path.relative_to(ROOT / ".runtime").as_posix(),
                        "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                        "bytes": source_path.stat().st_size,
                    }
                )
    (ROOT / ".runtime/native-source-inventory.json").write_text(
        json.dumps(inventory, indent=2) + "\n"
    )
    print("PASS verified native sources provisioned; no native executable run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
