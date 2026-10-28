# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Charts in ``CellsWorkbook`` JSON (§3.12, C10-09): the same validation and
refusals as the TypeScript core (``src/core/charts.ts``), a bad field named by
its path; inference of a chart's data from a selection, from the same table
of cases; and the refusals an agent meets (``NoNumericData``, ``ChartTooLarge``,
``UnknownChart``, ``DuplicateChart``, ``InvalidArgument``). Python draws
nothing: a picture of a chart is the browser's.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from .format import FormatError

BUILTIN_CHART_TYPES = ("bar", "column", "line", "area", "pie", "scatter", "combo")
CHART_VARIANTS = ("clustered", "stacked", "percent", "smooth", "doughnut")
LEGENDS = ("top", "right", "bottom", "left", "none")
MAX_CHART_POINTS = 100_000

Zone = tuple[int, int, int, int]  # top, left, bottom, right


class ChartRefusal(ValueError):
    """A chart command refused: ``reason`` is the TypeScript core's (``NoNumericData``, …)."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def _fail(path: str, message: str) -> None:
    raise FormatError(f"{path}: {message}")


def _is_object(x: Any) -> bool:
    return isinstance(x, dict)


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and x not in (float("inf"), float("-inf"))


def _positive(x: Any) -> bool:
    return _is_number(x) and x > 0


# ------------------------------------------------------------------ references

_SHEET = r"(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!"
_CELL = r"\$?([A-Za-z]{1,3})\$?([0-9]+)"
_REF = re.compile(rf"^(?:{_SHEET})?{_CELL}(?::{_CELL})?$")


def ref_zone(ref: Any) -> tuple[str | None, Zone] | None:
    """The sheet (``None`` for the chart's own) and zone a reference names; ``None`` when it is not one (``#REF!`` included)."""
    if not isinstance(ref, str):
        return None
    m = _REF.match(ref.strip())
    if m is None:
        return None
    from .workbook import column_index  # local: workbook imports this module

    quoted, bare, c0, r0, c1, r1 = m.groups()
    sheet = quoted.replace("''", "'") if quoted else bare
    top, left = int(r0) - 1, column_index(c0)
    if c1 is None:
        return sheet, (top, left, top, left)
    bottom, right = int(r1) - 1, column_index(c1)
    return sheet, (min(top, bottom), min(left, right), max(top, bottom), max(left, right))


def is_ref(ref: Any) -> bool:
    return ref == "#REF!" or ref_zone(ref) is not None


def zone_ref(sheet_name: str, zone: Zone) -> str:
    """A1 text of a zone, its sheet named and its corners anchored (``Sheet1!$B$2:$B$5``)."""
    from .workbook import column_letters

    quoted = (
        sheet_name
        if re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", sheet_name) and not re.match(r"^[A-Za-z]{1,3}[0-9]+$", sheet_name)
        else "'" + sheet_name.replace("'", "''") + "'"
    )
    top, left, bottom, right = zone
    a = f"${column_letters(left)}${top + 1}"
    b = f"${column_letters(right)}${bottom + 1}"
    return f"{quoted}!{a if a == b else a + ':' + b}"


# ------------------------------------------------------------------ validation


def _check_ref(v: Any, path: str) -> None:
    if not isinstance(v, str) or not is_ref(v):
        _fail(path, "not a range")


def _check_offset(v: Any, path: str, limits: dict[str, int]) -> None:
    if not _is_object(v):
        _fail(path, "a cell offset is { row, col, dx, dy }")
    for k in ("row", "col"):
        if not _is_int(v.get(k)) or v[k] < 0:
            _fail(f"{path}.{k}", "a non-negative integer")
    if v["row"] >= limits["rows"] or v["col"] >= limits["cols"]:
        _fail(path, "outside the sheet")
    for k in ("dx", "dy"):
        if not _is_number(v.get(k)) or v[k] < 0:
            _fail(f"{path}.{k}", "a non-negative number of px")


def _check_axis(v: Any, path: str) -> None:
    if not _is_object(v):
        _fail(path, "an axis is { title?, min?, max?, format?, log?, gridlines? }")
    for k in v:
        if k not in ("title", "min", "max", "format", "log", "gridlines"):
            _fail(f"{path}.{k}", "not a field of an axis")
    if "title" in v and not isinstance(v["title"], str):
        _fail(f"{path}.title", "a text")
    for k in ("min", "max"):
        if k in v and not _is_number(v[k]):
            _fail(f"{path}.{k}", "a number")
    if "format" in v and not isinstance(v["format"], str):
        _fail(f"{path}.format", "a number format")
    for k in ("log", "gridlines"):
        if k in v and not isinstance(v[k], bool):
            _fail(f"{path}.{k}", "true or false")


def check_chart(v: Any, path: str, limits: dict[str, int]) -> dict[str, Any]:
    """Raise :class:`FormatError` naming the first bad field of a chart; return it."""
    if not _is_object(v):
        _fail(path, "a chart is an object")
    for k in v:
        if k not in ("id", "type", "variant", "anchor", "data", "title", "legend", "axes", "labels"):
            _fail(f"{path}.{k}", "not a field of a chart")
    if not isinstance(v.get("id"), str) or v["id"] == "":
        _fail(f"{path}.id", "a non-empty string")
    if not isinstance(v.get("type"), str) or not re.match(r"^[a-z][a-zA-Z0-9.-]*$", v["type"]):
        _fail(f"{path}.type", "a chart type (column, line, … or a contributed type)")
    if "variant" in v and v["variant"] not in CHART_VARIANTS:
        _fail(f"{path}.variant", f"one of {', '.join(CHART_VARIANTS)}")
    a = v.get("anchor")
    if not _is_object(a):
        _fail(f"{path}.anchor", "an anchor is { kind, … }")
    kind = a.get("kind")
    if kind == "cells":
        _check_offset(a.get("from"), f"{path}.anchor.from", limits)
        _check_offset(a.get("to"), f"{path}.anchor.to", limits)
        if a["to"]["row"] < a["from"]["row"] or a["to"]["col"] < a["from"]["col"]:
            _fail(f"{path}.anchor", "from after to")
    elif kind == "cell":
        _check_offset(a.get("from"), f"{path}.anchor.from", limits)
        if not _positive(a.get("width")):
            _fail(f"{path}.anchor.width", "a positive number of px")
        if not _positive(a.get("height")):
            _fail(f"{path}.anchor.height", "a positive number of px")
    elif kind == "absolute":
        for k in ("x", "y"):
            if not _is_number(a.get(k)) or a[k] < 0:
                _fail(f"{path}.anchor.{k}", "a non-negative number of px")
        if not _positive(a.get("width")):
            _fail(f"{path}.anchor.width", "a positive number of px")
        if not _positive(a.get("height")):
            _fail(f"{path}.anchor.height", "a positive number of px")
    else:
        _fail(f"{path}.anchor.kind", "cells, cell or absolute")
    d = v.get("data")
    if not _is_object(d):
        _fail(f"{path}.data", "the data is { series, by, headers, blanks }")
    series = d.get("series")
    if not isinstance(series, list) or not series:
        _fail(f"{path}.data.series", "a non-empty list")
    for i, s in enumerate(series):
        sp = f"{path}.data.series[{i}]"
        if not _is_object(s):
            _fail(sp, "a series is { values, … }")
        for k in s:
            if k not in ("name", "values", "categories", "x", "type", "axis", "color"):
                _fail(f"{sp}.{k}", "not a field of a series")
        _check_ref(s.get("values"), f"{sp}.values")
        if "categories" in s:
            _check_ref(s["categories"], f"{sp}.categories")
        if "x" in s:
            _check_ref(s["x"], f"{sp}.x")
        if "name" in s and not isinstance(s["name"], str):
            _fail(f"{sp}.name", "a text or a range")
        if "type" in s and s["type"] not in ("column", "line", "area"):
            _fail(f"{sp}.type", "column, line or area")
        if "axis" in s and s["axis"] not in ("primary", "secondary"):
            _fail(f"{sp}.axis", "primary or secondary")
        if "color" in s and (not isinstance(s["color"], str) or not re.match(r"^#[0-9a-fA-F]{6}$", s["color"])):
            _fail(f"{sp}.color", "a colour such as #1f77b4")
    if d.get("by") not in ("columns", "rows"):
        _fail(f"{path}.data.by", "columns or rows")
    h = d.get("headers")
    if not _is_object(h) or not isinstance(h.get("row"), bool) or not isinstance(h.get("column"), bool):
        _fail(f"{path}.data.headers", "{ row, column }, true or false each")
    if d.get("blanks") not in ("gap", "zero", "connect"):
        _fail(f"{path}.data.blanks", "gap, zero or connect")
    if "title" in v and not isinstance(v["title"], str):
        _fail(f"{path}.title", "a text or a range")
    if v.get("legend") not in LEGENDS:
        _fail(f"{path}.legend", f"one of {', '.join(LEGENDS)}")
    if "axes" in v:
        if not _is_object(v["axes"]):
            _fail(f"{path}.axes", "{ x?, y?, y2? }")
        for k in v["axes"]:
            if k not in ("x", "y", "y2"):
                _fail(f"{path}.axes.{k}", "not an axis (x, y or y2)")
            _check_axis(v["axes"][k], f"{path}.axes.{k}")
    if "labels" in v and not isinstance(v["labels"], bool):
        _fail(f"{path}.labels", "true or false")
    return v


def chart_problem(v: Any, limits: dict[str, int], path: str = "chart") -> str | None:
    """The validation's sentence, or ``None`` when the chart is good."""
    try:
        check_chart(v, path, limits)
        return None
    except FormatError as error:
        return str(error)


# ------------------------------------------------------------------ inference

Read = Callable[[int, int], Any]


def _cells_of(z: Zone) -> int:
    return (z[2] - z[0] + 1) * (z[3] - z[1] + 1)


def infer_chart_data(
    read: Read,
    sheet_name: str,
    zone: Zone,
    is_date: Callable[[int, int], bool] | None = None,
) -> dict[str, Any]:
    """The data of a chart inferred from a selection, as the TypeScript core infers it.

    A first row of text over numbers names the series, a first column of text or
    dates holds the categories, more rows than columns gives series by columns
    (one column is one series); a selection with no number raises
    :class:`ChartRefusal` ``NoNumericData``, one past ``MAX_CHART_POINTS`` ``ChartTooLarge``.
    """
    is_date = is_date or (lambda r, c: False)
    top, left, bottom, right = zone
    rows = bottom - top + 1
    cols = right - left + 1

    def is_text(r: int, c: int) -> bool:
        return isinstance(read(r, c), str)

    def is_num(r: int, c: int) -> bool:
        return _is_number(read(r, c)) and not is_date(r, c)

    numbers = sum(1 for r in range(top, bottom + 1) for c in range(left, right + 1) if is_num(r, c))
    if numbers == 0:
        raise ChartRefusal("NoNumericData", "The selection holds no number to chart.")
    header_row = rows > 1
    for c in range(left + (1 if cols > 1 else 0), right + 1):
        if not header_row:
            break
        if not (is_text(top, c) or read(top, c) is None):
            header_row = False
    if header_row:
        header_row = any(is_text(top, c) for c in range(left, right + 1))
    header_column = cols > 1
    for r in range(top + (1 if header_row else 0), bottom + 1):
        if not header_column:
            break
        if not (is_text(r, left) or is_date(r, left) or read(r, left) is None):
            header_column = False
    body = (top + (1 if header_row else 0), left + (1 if header_column else 0), bottom, right)
    if body[0] > body[2] or body[1] > body[3]:
        raise ChartRefusal("NoNumericData", "The selection holds no number to chart.")
    points = _cells_of(body)
    if points > MAX_CHART_POINTS:
        raise ChartRefusal(
            "ChartTooLarge",
            f"A chart holds at most {MAX_CHART_POINTS:,} points; this selection has {points:,}.",
        )
    by_columns = body[2] - body[0] >= body[3] - body[1]
    series: list[dict[str, Any]] = []
    if by_columns:
        for c in range(body[1], body[3] + 1):
            s: dict[str, Any] = {"values": zone_ref(sheet_name, (body[0], c, body[2], c))}
            if header_row:
                s["name"] = zone_ref(sheet_name, (top, c, top, c))
            if header_column:
                s["categories"] = zone_ref(sheet_name, (body[0], left, body[2], left))
            series.append(s)
    else:
        for r in range(body[0], body[2] + 1):
            s = {"values": zone_ref(sheet_name, (r, body[1], r, body[3]))}
            if header_column:
                s["name"] = zone_ref(sheet_name, (r, left, r, left))
            if header_row:
                s["categories"] = zone_ref(sheet_name, (top, body[1], top, body[3]))
            series.append(s)
    return {
        "series": series,
        "by": "columns" if by_columns else "rows",
        "headers": {"row": header_row, "column": header_column},
        "blanks": "gap",
    }


def chart_refs(spec: dict[str, Any]) -> list[str]:
    """Every range a chart reads (values, categories, x, and a name read from a cell)."""
    refs: list[str] = []
    for s in spec["data"]["series"]:
        refs.append(s["values"])
        for k in ("categories", "x"):
            if k in s:
                refs.append(s[k])
        if "name" in s and ref_zone(s["name"]) is not None:
            refs.append(s["name"])
    return refs
