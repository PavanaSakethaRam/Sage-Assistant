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
    home = tmp_path / "git-home"
    home.mkdir()
    xdg = tmp_path / "git-xdg"
    xdg.mkdir()
    environment = {
        key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")
    }
    environment.update(
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_TEMPLATE_DIR=str(template),
        HOME=str(home),
        USERPROFILE=str(home),
        XDG_CONFIG_HOME=str(xdg),
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


def test_checkout_ignores_inherited_git_overrides_and_preserves_owned_sentinel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sentinel = tmp_path / "owned-sentinel"
    sentinel.mkdir()
    template = tmp_path / "sentinel-template"
    template.mkdir()
    home = tmp_path / "sentinel-home"
    home.mkdir()
    xdg = tmp_path / "sentinel-xdg"
    xdg.mkdir()
    clean_env = {
        key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")
    }
    clean_env.update(
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_TEMPLATE_DIR=str(template),
        HOME=str(home),
        USERPROFILE=str(home),
        XDG_CONFIG_HOME=str(xdg),
    )
    subprocess.run(["git", "-C", str(sentinel), "init", "--quiet"], env=clean_env, check=True)
    marker = sentinel / "owner.txt"
    marker.write_text("owned sentinel\n")
    subprocess.run(
        ["git", "-C", str(sentinel), "add", "--", "owner.txt"],
        env=clean_env,
        check=True,
    )
    protected = [marker, sentinel / ".git/config", sentinel / ".git/index"]
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in protected]
    for key, value in {
        "GIT_DIR": str(sentinel / ".git"),
        "GIT_COMMON_DIR": str(sentinel / ".git"),
        "GIT_WORK_TREE": str(sentinel),
        "GIT_INDEX_FILE": str(sentinel / ".git/index"),
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.autocrlf",
        "GIT_CONFIG_VALUE_0": "false",
    }.items():
        monkeypatch.setenv(key, value)
    (tmp_path / "target").mkdir()
    try:
        staged, checked_out = checkout_with_autocrlf(
            tmp_path / "target", Path("desktop/main/index.ts"), b"synthetic\n"
        )
        assert staged == checked_out == b"synthetic\n"
    finally:
        assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in protected] == before
