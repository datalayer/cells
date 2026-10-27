# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The ``cells`` command group."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from datalayer_cells import Workbook, __version__
from datalayer_cells.cli import app, plugin

runner = CliRunner()


def book(tmp_path: Path) -> Path:
    path = tmp_path / "budget.cells.json"
    Workbook.from_rows([["Item", "Cost"], ["Rent", 900], ["Food", 300]], name="Budget").save(path)
    return path


def test_show(tmp_path: Path):
    result = runner.invoke(app, ["show", str(book(tmp_path))])
    assert result.exit_code == 0, result.output
    assert result.output.strip() == "Budget\tA1:B3\t6 cells"


def test_get_and_set(tmp_path: Path):
    path = book(tmp_path)
    result = runner.invoke(app, ["set", str(path), "B4", "=B2+B3", "TRUE"])
    assert result.exit_code == 0, result.output
    assert Workbook.load(path).formulas("B4") == [["=B2+B3"]]
    result = runner.invoke(app, ["get", str(path), "A2:C4"])
    assert result.output.splitlines() == ["Rent\t900\t", "Food\t300\t", "\t\tTRUE"]
    result = runner.invoke(app, ["get", str(path), "B4", "--formulas"])
    assert result.output.strip() == "=B2+B3"


def test_export(tmp_path: Path):
    path = book(tmp_path)
    result = runner.invoke(app, ["export", str(path), "--format", "csv"])
    assert result.output == "Item,Cost\nRent,900\nFood,300\n"
    result = runner.invoke(app, ["export", str(path), "--format", "json"])
    assert json.loads(result.output)["sheets"][0]["name"] == "Budget"


def test_refusals_exit_non_zero_with_a_sentence(tmp_path: Path):
    path = book(tmp_path)
    assert "No sheet 'Nope'" in runner.invoke(app, ["get", str(path), "Nope!A1"]).output
    bad = tmp_path / "bad.cells.json"
    bad.write_text('{"version": 2, "sheets": []}')
    result = runner.invoke(app, ["show", str(bad)])
    assert result.exit_code == 1
    assert "version: this is format version 2" in result.output
    assert runner.invoke(app, ["export", str(path), "--format", "xlsx"]).exit_code == 1


def test_version_and_the_plugin():
    assert runner.invoke(app, ["version"]).output.strip() == __version__
    manifest, extension = plugin()
    assert manifest.name == "cells-cli"
    assert hasattr(extension, "provide_cli")
