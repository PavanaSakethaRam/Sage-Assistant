"""Configuration must not grant network authority from labels or URLs."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from sage.config import Settings
from sage.paths import app_paths


def test_local_mode_has_no_reasoning_backend() -> None:
    assert Settings(ai_mode="local").reasoning_backend is None


@pytest.mark.parametrize(
    ("backend", "url"),
    [
        ("copilot", None),
        ("api", "https://example.com/v1"),
        ("local", "https://example.com/v1"),
        ("local", "http://localhost:8080"),
        ("local", "http://127.0.0.1:8080"),
        ("local", "http://[::1]:8080"),
    ],
)
def test_local_mode_rejects_cloud_destination(backend: str, url: str | None) -> None:
    # A loopback address alone is not evidence of reviewed local inference.
    with pytest.raises(ValueError):
        Settings(ai_mode="local").validate_reasoning_destination(backend, url)


@pytest.mark.parametrize("payload", [{"ai_mode": "unknown"}, {"ai_mode": 1}, {"path": "/tmp"}])
def test_settings_are_closed_and_strict(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate(payload)


def test_app_paths_override_is_inert_and_scoped(tmp_path: Path) -> None:
    root = tmp_path / "not-created"
    paths = app_paths(root_override=root)
    assert paths.data_dir == root / "data"
    assert paths.config_dir == root / "config"
    assert paths.cache_dir == root / "cache"
    assert paths.database == root / "data" / "sage.sqlite3"
    assert not root.exists()


def test_default_paths_are_per_user_and_inert(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    paths = app_paths()
    for path in (paths.data_dir, paths.config_dir, paths.cache_dir):
        assert path.is_relative_to(tmp_path)
        assert "Sage" in path.parts
        assert not path.exists()


@pytest.mark.parametrize("mode", ["assistant", "api"])
def test_nonlocal_mode_can_validate_an_explicit_backend(mode: str) -> None:
    settings = Settings.model_validate({"ai_mode": mode})
    settings.validate_reasoning_destination("copilot", None)


def test_settings_cannot_be_mutated() -> None:
    with pytest.raises(ValidationError):
        Settings().ai_mode = "assistant"


@pytest.mark.parametrize(
    "payload",
    [{"reasoning_backend": "unknown"}, {"ai_mode": "local", "reasoning_backend": "copilot"}],
)
def test_unsafe_configured_backends_rejected(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate(payload)


def test_nonlocal_mode_rejects_unknown_backend() -> None:
    with pytest.raises(ValueError):
        Settings(ai_mode="assistant").validate_reasoning_destination("shell", None)
