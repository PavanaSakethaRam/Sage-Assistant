"""Resolve application paths without creating directories or opening storage."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppPaths:
    data_dir: Path
    config_dir: Path
    cache_dir: Path

    @property
    def database(self) -> Path:
        return self.data_dir / "sage.sqlite3"


def app_paths(root_override: Path | None = None) -> AppPaths:
    """The override is trusted startup/test input, never renderer or model data."""
    if root_override is not None:
        return AppPaths(root_override / "data", root_override / "config", root_override / "cache")
    # On Windows platformdirs imports ctypes; keep module import passive.
    from platformdirs import user_cache_path, user_config_path, user_data_path

    return AppPaths(
        user_data_path("Sage", appauthor=False, ensure_exists=False),
        user_config_path("Sage", appauthor=False, ensure_exists=False),
        user_cache_path("Sage", appauthor=False, ensure_exists=False),
    )
