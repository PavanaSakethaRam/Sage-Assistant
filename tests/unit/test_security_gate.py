"""Collection failures and untriaged secret findings cannot turn green."""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

PATH = Path(__file__).resolve().parents[2] / "scripts/verify_security.py"


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_security", PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_secret_report_drops_source_values() -> None:
    result = load().secret_result(
        2,
        [
            {
                "RuleID": "generic-api-key",
                "File": "src/example.py",
                "StartLine": 4,
                "Secret": "private-marker",
                "Match": "private-marker",
                "Line": "private-marker",
            }
        ],
        "",
    )
    assert result["status"] == "violations"
    assert "private-marker" not in str(result)
    assert result["findings"] == [
        {"rule": "generic-api-key", "path": "src/example.py", "line": 4, "triage": "untriaged"}
    ]


@pytest.mark.parametrize(
    ("code", "data", "diagnostics"),
    [(1, [], ""), (0, {}, ""), (0, [], "warning: skipped file"), (0, [{"RuleID": "x"}], "")],
)
def test_secret_incomplete_fails_closed(code: int, data: object, diagnostics: str) -> None:
    assert load().secret_result(code, data, diagnostics)["status"] == "incomplete"


def test_advisory_severity_unknown_is_unresolved() -> None:
    assert (
        load().python_result(
            1,
            {
                "dependencies": [
                    {
                        "name": "example",
                        "version": "1",
                        "vulns": [{"id": "PYSEC-example", "aliases": []}],
                    }
                ]
            },
            {"example": "1"},
        )["status"]
        == "violations"
    )


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"dependencies": []},
        {"dependencies": [{"name": "example", "version": "2", "vulns": []}]},
    ],
)
def test_python_missing_inventory_fails(data: object) -> None:
    assert load().python_result(0, data, {"example": "1"})["status"] == "incomplete"
