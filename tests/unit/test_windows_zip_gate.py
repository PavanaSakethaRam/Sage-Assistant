"""The archive gate checks bytes and hidden entries, not just Forge's return path."""

import stat
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


def test_exact_zip_inventory_accepts_windows_file_and_directory_metadata(tmp_path: Path) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        for name, body, attributes in (
            (".hidden", b"dot file", 0x20),
            ("nested/", b"", 0x10),
            ("nested/body.txt", b"nested body", 0x20),
        ):
            info = zipfile.ZipInfo(name)
            info.create_system = 0
            info.external_attr = attributes
            zipped.writestr(info, body)
    assert verify(appdir, archive) == 2


@pytest.mark.parametrize("file_bits,directory_bits", [(0o666, 0o777), (0o644, 0o755)])
def test_exact_zip_inventory_accepts_windows_creator_with_posix_stat_mode(
    tmp_path: Path, file_bits: int, directory_bits: int
) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        for name, body, mode in (
            (".hidden", b"dot file", stat.S_IFREG | file_bits),
            ("nested/", b"", stat.S_IFDIR | directory_bits),
            ("nested/body.txt", b"nested body", stat.S_IFREG | file_bits),
        ):
            info = zipfile.ZipInfo(name)
            info.create_system = 0
            info.external_attr = mode << 16
            zipped.writestr(info, body)
    assert verify(appdir, archive) == 2


@pytest.mark.parametrize("name", ["nested/body.txt", "nested/"])
@pytest.mark.parametrize("ambiguous_bit", [0x200, 0x400, 0x800])
def test_zip_inventory_rejects_windows_creator_ambiguous_special_mode(
    tmp_path: Path, name: str, ambiguous_bit: int
) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.write(appdir / ".hidden", ".hidden")
        if name == "nested/":
            zipped.write(appdir / "nested" / "body.txt", "nested/body.txt")
        info = zipfile.ZipInfo(name)
        info.create_system = 0
        file_type = stat.S_IFDIR if name.endswith("/") else stat.S_IFREG
        info.external_attr = (file_type | ambiguous_bit) << 16
        zipped.writestr(info, b"" if name.endswith("/") else b"nested body")
    with pytest.raises(ZipInventoryError, match="unsupported_entry_type"):
        verify(appdir, archive)


@pytest.mark.parametrize("name", ["nested/body.txt", "nested/"])
def test_zip_inventory_rejects_archive_symlink_even_when_bytes_match(
    tmp_path: Path, name: str
) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.write(appdir / ".hidden", ".hidden")
        if name == "nested/":
            zipped.write(appdir / "nested" / "body.txt", "nested/body.txt")
        info = zipfile.ZipInfo(name)
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zipped.writestr(info, b"nested body" if name.endswith(".txt") else b"")
    with pytest.raises(ZipInventoryError, match="unsupported_entry_type"):
        verify(appdir, archive)


@pytest.mark.parametrize("file_type", [stat.S_IFIFO, stat.S_IFCHR, stat.S_IFSOCK])
def test_zip_inventory_rejects_other_nonregular_archive_types(
    tmp_path: Path, file_type: int
) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.write(appdir / ".hidden", ".hidden")
        info = zipfile.ZipInfo("nested/body.txt")
        info.create_system = 3
        info.external_attr = (file_type | 0o644) << 16
        zipped.writestr(info, b"nested body")
    with pytest.raises(ZipInventoryError, match="unsupported_entry_type"):
        verify(appdir, archive)


def test_zip_inventory_rejects_windows_reparse_attribute(tmp_path: Path) -> None:
    appdir, archive = package(tmp_path)
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.write(appdir / ".hidden", ".hidden")
        info = zipfile.ZipInfo("nested/body.txt")
        info.create_system = 0
        info.external_attr = 0x400 << 16
        zipped.writestr(info, b"nested body")
    with pytest.raises(ZipInventoryError, match="unsupported_entry_type"):
        verify(appdir, archive)


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
