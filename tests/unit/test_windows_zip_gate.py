"""The archive gate checks bytes and hidden entries, not just Forge's return path."""

import zipfile
from pathlib import Path

import pytest

from scripts.check_windows_zip import ZipInventoryError, verify


def package(tmp_path: Path) -> tuple[Path, Path]:
    appdir = tmp_path / "Sage & $' special"
    (appdir / "nested").mkdir(parents=True)
    (appdir / ".hidden").write_text("dot file")
    (appdir / "nested" / "body.txt").write_text("nested body")
    return appdir, tmp_path / "output & $' special.zip"


def test_exact_zip_inventory_accepts_hidden_files_and_special_paths(tmp_path: Path) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        for path in appdir.rglob("*"):
            if path.is_file():
                zipped.write(path, path.relative_to(appdir).as_posix())
    assert verify(appdir, archive) == 2


@pytest.mark.parametrize("damage", ["missing_hidden", "changed_content", "traversal", "duplicate"])
def test_zip_inventory_rejects_missing_changed_or_unsafe_entries(
    tmp_path: Path, damage: str
) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        if damage != "missing_hidden":
            zipped.write(appdir / ".hidden", ".hidden")
        zipped.writestr(
            "nested/body.txt", "changed" if damage == "changed_content" else "nested body"
        )
        if damage == "traversal":
            zipped.writestr("../outside", "synthetic")
        if damage == "duplicate":
            with pytest.warns(UserWarning, match="Duplicate name"):
                zipped.writestr("nested/body.txt", "nested body")
    with pytest.raises(ZipInventoryError):
        verify(appdir, archive)
