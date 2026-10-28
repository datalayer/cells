# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Charts from Python (C10-09): the shared malformed corpus refused with the same paths as
TypeScript, the C10-07 fixture's JSON round-tripped, the inference table, the agent API
with the shared refusals, and the CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from datalayer_cells import ChartRefusal, FormatError, MAX_CHART_POINTS, Workbook, infer_chart_data, validate_workbook
from datalayer_cells.cli import app

FORMAT = Path(__file__).resolve().parents[2] / "tests" / "format"
CORPUS = json.loads((FORMAT / "charts-malformed.json").read_text(encoding="utf-8"))
runner = CliRunner()


def workbook_with(chart: object) -> dict:
    return {
        "version": 1,
        "styles": [{}],
        "sheets": [
            {
                "id": "s1",
                "name": "Sheet1",
                "rows": {"1": {"cells": {"1": {"v": 1}}}, "2": {"cells": {"1": {"v": 2}}}},
                "charts": {"c1": chart},
            }
        ],
    }


def test_the_good_chart_of_the_corpus_loads():
    wb = Workbook(workbook_with(CORPUS["good"]))
    assert [c["id"] for c in wb.charts()] == ["c1"]


@pytest.mark.parametrize("case", CORPUS["cases"], ids=[c["name"] for c in CORPUS["cases"]])
def test_the_malformed_corpus_is_refused_with_the_typescript_path(case):
    with pytest.raises(FormatError) as error:
        validate_workbook(workbook_with(case["chart"]))
    assert str(error.value).startswith(case["path"] + ":")


def test_the_charts_workbook_of_c10_07_round_trips(tmp_path: Path):
    data = json.loads((FORMAT / "workbooks" / "charts.json").read_text(encoding="utf-8"))
    wb = Workbook(data)
    assert wb.to_json() == data
    names = [c["title"] for c in wb.charts("Figures")]
    assert names == ["Column", "Stacked", "Percent", "Bar", "Line", "Area", "Pie", "Doughnut", "Scatter", "Combo"]
    out = tmp_path / "charts.cells.json"
    wb.save(out)
    assert Workbook.load(out).to_json() == data


SALES = [["Month", "North", "South"], ["Jan", 10, 7], ["Feb", 12, 9], ["Mar", 15, 11], ["Apr", 13, 14]]


def grid(rows):
    return lambda r, c: rows[r][c] if r < len(rows) and c < len(rows[r]) else None


INFERENCE = [
    (
        "headers in the first row and column",
        SALES,
        {"by": "columns", "headers": {"row": True, "column": True}, "series": 2,
         "first": {"name": "Sheet1!$B$1", "values": "Sheet1!$B$2:$B$5", "categories": "Sheet1!$A$2:$A$5"}},
    ),
    ("no headers", [[1, 2], [3, 4], [5, 6]], {"by": "columns", "headers": {"row": False, "column": False}, "series": 2, "first": {"values": "Sheet1!$A$1:$A$3"}}),
    (
        "more columns than rows: series by rows",
        [["", "Jan", "Feb", "Mar", "Apr"], ["N", 1, 2, 3, 4], ["S", 5, 6, 7, 8]],
        {"by": "rows", "headers": {"row": True, "column": True}, "series": 2,
         "first": {"name": "Sheet1!$A$2", "values": "Sheet1!$B$2:$E$2", "categories": "Sheet1!$B$1:$E$1"}},
    ),
    ("one column: one series", [[4], [5], [6]], {"by": "columns", "series": 1, "first": {"values": "Sheet1!$A$1:$A$3"}}),
    ("one column under a header", [["Sales"], [4], [5]], {"by": "columns", "headers": {"row": True, "column": False}, "series": 1, "first": {"name": "Sheet1!$A$1", "values": "Sheet1!$A$2:$A$3"}}),
]


@pytest.mark.parametrize("name,rows,want", INFERENCE, ids=[i[0] for i in INFERENCE])
def test_inference_shares_the_typescript_table(name, rows, want):
    data = infer_chart_data(grid(rows), "Sheet1", (0, 0, len(rows) - 1, len(rows[0]) - 1))
    assert data["by"] == want["by"]
    if "headers" in want:
        assert data["headers"] == want["headers"]
    assert len(data["series"]) == want["series"]
    assert data["series"][0] == want["first"]


def test_inference_dates_text_only_and_too_large():
    rows = [[45000, 1], [45031, 2], [45061, 3]]
    data = infer_chart_data(grid(rows), "Sheet1", (0, 0, 2, 1), lambda r, c: c == 0)
    assert data["series"] == [{"values": "Sheet1!$B$1:$B$3", "categories": "Sheet1!$A$1:$A$3"}]
    with pytest.raises(ChartRefusal) as refused:
        infer_chart_data(grid([["a", "b"], ["c", "d"]]), "Sheet1", (0, 0, 1, 1))
    assert refused.value.reason == "NoNumericData"
    with pytest.raises(ChartRefusal) as refused:
        infer_chart_data(lambda r, c: 1, "Sheet1", (0, 0, MAX_CHART_POINTS, 0))
    assert refused.value.reason == "ChartTooLarge"
    assert "100,000" in str(refused.value)


def sales() -> Workbook:
    return Workbook.from_rows(SALES, name="Sheet1")


def test_the_agent_api_adds_updates_and_removes_with_the_shared_refusals():
    wb = sales()
    spec = wb.add_chart("column", data="Sheet1!A1:C5", anchor="E2:L18", title="Sales")
    assert spec["id"] == "chart1"
    assert spec["anchor"] == {"kind": "cells", "from": {"row": 1, "col": 4, "dx": 0, "dy": 0}, "to": {"row": 18, "col": 12, "dx": 0, "dy": 0}}
    assert [s["values"] for s in spec["data"]["series"]] == ["Sheet1!$B$2:$B$5", "Sheet1!$C$2:$C$5"]
    assert spec["data"]["headers"] == {"row": True, "column": True}
    assert wb.charts() == [spec]
    assert validate_workbook(wb.to_json())["sheets"][0]["charts"]["chart1"] == spec
    with pytest.raises(ChartRefusal) as refused:
        wb.add_chart("pie", data="A1:A5", anchor="E20:H30")
    assert refused.value.reason == "NoNumericData"
    with pytest.raises(ChartRefusal) as refused:
        wb.add_chart("pie", data="B2:B5", anchor="E20:H30", id="chart1")
    assert refused.value.reason == "DuplicateChart"
    with pytest.raises(ChartRefusal) as refused:
        wb.add_chart("Pie", data="B2:B5", anchor="E20:H30")
    assert refused.value.reason == "InvalidArgument" and "chart.type" in str(refused.value)
    updated = wb.update_chart("chart1", type="line", title=None, legend="right")
    assert updated["type"] == "line" and "title" not in updated and updated["legend"] == "right"
    with pytest.raises(ChartRefusal) as refused:
        wb.update_chart("chart1", anchor={"kind": "absolute", "x": 0, "y": 0, "width": 1, "height": 1})
    assert refused.value.reason == "InvalidArgument"
    with pytest.raises(ChartRefusal) as refused:
        wb.update_chart("chart1", legend="middle")
    assert refused.value.reason == "InvalidArgument" and "chart.legend" in str(refused.value)
    with pytest.raises(ChartRefusal) as refused:
        wb.update_chart("nope", title="x")
    assert refused.value.reason == "UnknownChart"
    wb.remove_chart("chart1")
    assert wb.charts() == []
    with pytest.raises(ChartRefusal):
        wb.remove_chart("chart1")


def test_the_cli_lists_adds_and_removes(tmp_path: Path):
    path = tmp_path / "sales.cells.json"
    sales().save(path)
    result = runner.invoke(app, ["charts", "list", str(path)])
    assert result.exit_code == 0 and result.output.strip() == "Sheet1: no chart"
    result = runner.invoke(app, ["charts", "add", str(path), "column", "Sheet1!A1:C5", "E2:L18", "--title", "Sales"])
    assert result.exit_code == 0, result.output
    assert "chart1" in result.output
    result = runner.invoke(app, ["charts", "list", str(path)])
    assert "chart1\tcolumn\tSales\tE2:L18\t2 series" in result.output
    result = runner.invoke(app, ["charts", "add", str(path), "pie", "A1:A5", "E20:H30"])
    assert result.exit_code == 1 and "no number" in result.output
    result = runner.invoke(app, ["charts", "remove", str(path), "chart1"])
    assert result.exit_code == 0
    assert Workbook.load(path).charts() == []
    result = runner.invoke(app, ["charts", "remove", str(path), "chart1"])
    assert result.exit_code == 1 and "No chart 'chart1'" in result.output
