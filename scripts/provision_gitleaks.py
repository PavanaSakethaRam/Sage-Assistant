"""Provision the exact official scanner after verifying its release archive digest."""

import hashlib
import io
import platform
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.30.1"
ARCHIVES = {
    ("Darwin", "arm64"): (
        "darwin_arm64.tar.gz",
        "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    ),
    ("Darwin", "x86_64"): (
        "darwin_x64.tar.gz",
        "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    ),
    ("Windows", "AMD64"): (
        "windows_x64.zip",
        "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
    ),
    ("Windows", "ARM64"): (
        "windows_arm64.zip",
        "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f",
    ),
}


def provision() -> Path:
    archive, expected = ARCHIVES[(platform.system(), platform.machine())]
    url = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_{archive}"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(50_000_000)
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("scanner archive digest mismatch")
    name = "gitleaks.exe" if archive.endswith("zip") else "gitleaks"
    if archive.endswith("zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            binary = package.read(name)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as package:
            member = package.extractfile(name)
            if member is None:
                raise ValueError("scanner missing")
            binary = member.read()
    target = ROOT / ".cache/tooling" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    target.chmod(0o700)
    target.with_suffix(".sha256").write_text(hashlib.sha256(binary).hexdigest())
    print(f"Verified official Gitleaks {VERSION} archive SHA-256 {expected}")
    return target


if __name__ == "__main__":
    provision()
