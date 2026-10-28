# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Reading and writing a workbook by A1 reference, as an agent does."""

from __future__ import annotations

import pytest

from datalayer_cells import Workbook, column_index, column_letters, parse_a1, parse_input, parse_zone


def test_a1_notation():
    assert column_letters(0) == "A" and column_letters(25) == "Z" and column_letters(26) == "AA"
    assert column_index("XFD") == 16_383
    assert parse_a1("$B$3") == (2, 1)
    assert parse_zone("C4:A1") == (0, 0, 3, 2)
    with pytest.raises(ValueError, match="not a cell reference"):
        parse_a1("B0")


def test_reads_and_writes_values_and_formulas():
    wb = Workbook.from_rows([["a", "b"], [1, 2]])
    wb.write("C2", [["=A2+B2", True, {"error": "#N/A"}]])
    assert wb.read("A1:E2") == [["a", "b", None, None, None], [1, 2, None, True, {"error": "#N/A"}]]
    assert wb.formulas("C2") == [["=A2+B2"]]
    assert wb.cell("C2") == {"f": "A2+B2"}
    wb.write("A1", [[None]])
    assert wb.cell("A1") is None


def test_styles_and_sheets_round_trip_through_json():
    wb = Workbook.from_rows([[1, 2, 3]])
    wb.style("A1:B1", {"bold": True})
    wb.add_sheet("Notes")
    wb.write("Notes!B2", [["hello"]])
    again = Workbook(wb.to_json())
    assert again.to_json() == wb.to_json()
    assert again.read("'Notes'!B2") == [["hello"]]
    assert wb.to_json()["styles"] == [{}, {"bold": True}]
    wb.style("A1:B1", None)
    assert wb.to_json()["styles"] == [{}]


def test_refuses_with_a_sentence():
    wb = Workbook.from_rows([[1]])
    with pytest.raises(KeyError, match="No sheet 'Nope'"):
        wb.read("Nope!A1")
    with pytest.raises(ValueError, match="not a cell value"):
        wb.write("A1", [[float("inf")]])
    with pytest.raises(ValueError, match="an error is"):
        wb.write("A1", [[{"oops": 1}]])
    with pytest.raises(ValueError, match="is a range"):
        wb.cell("A1:B2")
    with pytest.raises(ValueError, match="already"):
        wb.add_sheet("sheet1")


@pytest.mark.parametrize(
    "text, cell",
    [("12", {"v": 12}), ("1.5", {"v": 1.5}), ("TRUE", {"v": True}), ("=A1*2", {"f": "A1*2"}), ("'12", {"v": "12"}), ("hi", {"v": "hi"}), ("", {})],
)
def test_parses_input_as_typing_does(text, cell):
    assert parse_input(text) == cell


def test_a_cell_type_is_a_style_property():
    wb = Workbook.from_rows([[True, "https://datalayer.io", 0.42]])
    wb.style("A1", {"type": "checkbox"})
    wb.style("B1", {"type": "link"})
    wb.style("C1", {"type": "progress"})
    assert wb.to_json()["styles"] == [{}, {"type": "checkbox"}, {"type": "link"}, {"type": "progress"}]
    assert Workbook(wb.to_json()).to_json() == wb.to_json()
    with pytest.raises(Exception, match=r"style\.type: the id of a cell type, a non-empty string"):
        wb.style("A1", {"type": ""})


def test_a_data_source_binding_is_carried_and_validated():
    wb = Workbook.from_rows([["Orders"]])
    data = wb.to_json()
    data["sheets"][0]["dataSource"] = {"id": "orders", "row": 2, "col": 1, "rows": 100, "cols": 3}
    again = Workbook(data)
    assert again.to_json()["sheets"][0]["dataSource"] == {"id": "orders", "row": 2, "col": 1, "rows": 100, "cols": 3}
    for bad, message in [
        ({"id": "", "row": 0, "col": 0, "rows": 1, "cols": 1}, r"sheets\[0\]\.dataSource\.id: the id of a data source"),
        ({"id": "x", "row": -1, "col": 0, "rows": 1, "cols": 1}, r"sheets\[0\]\.dataSource\.row: a non-negative integer"),
        ({"id": "x", "row": 0, "col": 0, "rows": 0, "cols": 1}, r"sheets\[0\]\.dataSource\.rows: at least 1"),
        ({"id": "x", "row": 0, "col": 0, "rows": 2_000_000, "cols": 1}, r"sheets\[0\]\.dataSource: reaches outside the sheet"),
    ]:
        data["sheets"][0]["dataSource"] = bad
        with pytest.raises(Exception, match=message):
            Workbook(data)
