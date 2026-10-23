"""Release checks reject added private/native files and nonportable links."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/package_manifest.py"


def command(root: Path, manifest: Path, record: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(root), "--manifest", str(manifest)]
        + (["--record"] if record else []),
        capture_output=True,
        text=True,
        check=False,
    )


def tree(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "resources"
    core = root / "core"
    core.mkdir(parents=True)
    executable = core / ("sage-core.exe" if os.name == "nt" else "sage-core")
    executable.write_bytes(b"synthetic executable")
    executable.chmod(0o755)
    return root, tmp_path / "manifest.json"


def test_recorded_tree_detects_modified_native_bytes(tmp_path: Path) -> None:
    root, manifest = tree(tmp_path)
    assert command(root, manifest, True).returncode == 0
    assert command(root, manifest).returncode == 0
    executable = next((root / "core").iterdir())
    executable.write_bytes(b"changed executable")
    assert command(root, manifest).returncode != 0


@pytest.mark.parametrize(
    "name", ["modules/legacy.py", "tests/prompt.txt", "credentials.json", ".env", "evil.dylib"]
)
def test_unexpected_private_or_native_resource_is_rejected(tmp_path: Path, name: str) -> None:
    root, manifest = tree(tmp_path)
    assert command(root, manifest, True).returncode == 0
    path = root / name
    path.parent.mkdir(exist_ok=True, parents=True)
    path.write_text("synthetic private content")
    result = command(root, manifest)
    assert result.returncode != 0
    assert "synthetic private content" not in result.stdout + result.stderr


def test_missing_core_cannot_be_recorded(tmp_path: Path) -> None:
    root = tmp_path / "resources"
    root.mkdir()
    assert command(root, tmp_path / "manifest.json", True).returncode != 0


@pytest.mark.skipif(os.name == "nt", reason="Symlink creation requires Windows privilege")
@pytest.mark.parametrize("target", ["/tmp/outside", "../../outside"])
def test_escaping_symlink_is_rejected_before_manifest_creation(tmp_path: Path, target: str) -> None:
    root, manifest = tree(tmp_path)
    (root / "core/link").symlink_to(target)
    assert command(root, manifest, True).returncode != 0
    assert not manifest.exists()


@pytest.mark.skipif(os.name == "nt", reason="Symlink creation requires Windows privilege")
def test_portable_symlink_and_mode_are_part_of_inventory(tmp_path: Path) -> None:
    root, manifest = tree(tmp_path)
    (root / "core/library").write_bytes(b"synthetic library")
    (root / "core/link").symlink_to("library")
    assert command(root, manifest, True).returncode == 0
    data = json.loads(manifest.read_text())
    assert data["entries"]["core/link"]["target"] == "library"
    (root / "core/library").chmod(0o755)
    assert command(root, manifest).returncode != 0


def test_native_source_inventory_rejects_added_library_and_modified_pin(tmp_path: Path) -> None:
    from scripts.package_manifest import validate_sources

    source = tmp_path / "copilot/1.0.102"
    source.mkdir(parents=True)
    (source / "runtime.node").write_bytes(b"native")
    rows: list[dict[str, str | int]] = [
        {
            "path": "copilot/1.0.102/runtime.node",
            "bytes": 6,
            "sha256": "bef32d2c315a289576f2a6828d27edb16bb316a4d85c271f2d794045f3ea668d",
        }
    ]
    validate_sources(tmp_path, rows)
    (source / "unexpected.dylib").write_bytes(b"unexpected")
    with pytest.raises(ValueError):
        validate_sources(tmp_path, rows)
    (source / "unexpected.dylib").unlink()
    (source / "runtime.node").write_bytes(b"mutated")
    with pytest.raises(ValueError):
        validate_sources(tmp_path, rows)


def test_frozen_module_allowlist_rejects_optional_developer_tooling() -> None:
    from scripts.build_core import validate_modules

    validate_modules({"sage.service", "ssl", "pydantic.main", "copilot.client"})
    for forbidden in ("_pytest.config", "mypy.main", "numpy", "unreviewed_native"):
        with pytest.raises(ValueError):
            validate_modules({"sage.service", forbidden})


def test_packaged_host_resources_do_not_hide_unexpected_files(tmp_path: Path) -> None:
    root, manifest = tree(tmp_path)
    assert command(root, manifest, True).returncode == 0
    (root / "app.asar").write_bytes(b"synthetic host archive")
    args = [sys.executable, str(SCRIPT), str(root), "--manifest", str(manifest), "--packaged"]
    assert subprocess.run(args, capture_output=True, check=False).returncode == 0
    (root / "unexpected.node").write_bytes(b"unreviewed native library")
    assert subprocess.run(args, capture_output=True, check=False).returncode != 0


def test_fixed_source_fetch_rejects_checksum_mismatch_without_reflecting_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io

    from scripts.provision_package import fetch

    class Response(io.BytesIO):
        pass

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: Response(b"synthetic"))
    with pytest.raises(ValueError, match="Native source checksum mismatch"):
        fetch("https://github.com/synthetic", "0" * 64)


def test_staging_keeps_production_javascript_notices_and_excludes_build_dependencies(
    tmp_path: Path,
) -> None:
    from scripts.stage_package import copy_javascript_notices

    for package in ["runtime", "build"]:
        source = tmp_path / "node_modules" / package
        source.mkdir(parents=True)
        (source / "LICENSE").write_text(f"Synthetic {package} notice")
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "packages": {
                    "": {},
                    "node_modules/runtime": {"version": "1"},
                    "node_modules/build": {"version": "1", "dev": True},
                }
            }
        )
    )
    target = tmp_path / "notices"
    copy_javascript_notices(tmp_path, target)
    assert (target / "runtime/LICENSE").read_text() == "Synthetic runtime notice"
    assert not (target / "build").exists()


def test_javascript_notices_preserve_nested_dependency_versions(tmp_path: Path) -> None:
    from scripts.stage_package import copy_javascript_notices

    packages = {
        "node_modules/shared": "Synthetic shared version one notice",
        "node_modules/parent/node_modules/shared": "Synthetic shared version two notice",
    }
    for name, content in packages.items():
        source = tmp_path / name
        source.mkdir(parents=True)
        (source / "LICENSE").write_text(content)
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {"packages": {name: {"version": str(index)} for index, name in enumerate(packages)}}
        )
    )
    target = tmp_path / "notices"
    copy_javascript_notices(tmp_path, target)
    assert sorted(path.read_text() for path in target.rglob("LICENSE")) == [
        "Synthetic shared version one notice",
        "Synthetic shared version two notice",
    ]


def test_electron_bom_versions_come_from_the_pinned_vendor_runtime() -> None:
    from scripts.stage_package import electron_component_versions

    versions = electron_component_versions(ROOT)
    assert versions == {
        "electron": "45.0.0",
        "chrome": "156.0.8078.48",
        "node": "24.22.0",
        "v8": "15.6.75.19-electron.0",
    }
