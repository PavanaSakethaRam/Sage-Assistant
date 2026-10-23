"""Keep the pinned vendor notice's bytes intact in a Windows Git checkout."""

import hashlib
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NOTICE = Path("docs/third-party/github-copilot-sdk-1.0.25-LICENSE.txt")
EXPECTED_SHA256 = "2510b446bc1f0cf9702453075d20cd88631e20e5642658edb7325d9c1eb534f7"


def checkout_with_autocrlf(tmp_path: Path, path: Path, source: bytes) -> tuple[bytes, bytes]:
    repo = tmp_path / "repo"
    repo.mkdir()
    template = tmp_path / "empty-git-template"
    template.mkdir()
    environment = os.environ.copy()
    environment.update(
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_TEMPLATE_DIR=str(template),
    )

    def git(*args: str) -> bytes:
        return subprocess.run(
            ["git", "-C", str(repo), "-c", "core.autocrlf=true", *args],
            env=environment,
            check=True,
            capture_output=True,
        ).stdout

    git("init", "--quiet")
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source)
    attributes = ROOT / ".gitattributes"
    if attributes.exists():
        (repo / ".gitattributes").write_bytes(attributes.read_bytes())
        git("add", "--", ".gitattributes")
    git("add", "--", path.as_posix())

    staged = git("show", f":{path.as_posix()}")
    target.unlink()
    git("checkout-index", "--force", "--", path.as_posix())
    return staged, target.read_bytes()


def test_vendor_notice_survives_git_autocrlf_checkout(tmp_path: Path) -> None:
    source = (ROOT / NOTICE).read_bytes()
    assert hashlib.sha256(source).hexdigest() == EXPECTED_SHA256
    staged, checked_out = checkout_with_autocrlf(tmp_path, NOTICE, source)
    assert hashlib.sha256(staged).hexdigest() == EXPECTED_SHA256
    assert hashlib.sha256(checked_out).hexdigest() == EXPECTED_SHA256


@pytest.mark.parametrize(
    "path",
    [
        "desktop/main/index.ts",
        "e2e/harness.ts",
        "scripts/check_package.ts",
        "scripts/verify.mjs",
        "forge.config.ts",
        "package.json",
    ],
)
def test_formatted_sources_keep_lf_in_windows_checkout(tmp_path: Path, path: str) -> None:
    staged, checked_out = checkout_with_autocrlf(tmp_path, Path(path), b"synthetic\n")
    assert staged == checked_out == b"synthetic\n"
