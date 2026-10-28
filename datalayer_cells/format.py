# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The ``CellsWorkbook`` format: validation with the TypeScript loader's refusals.

A file that does not match is refused with a sentence naming the path of the
first bad field, the same sentence ``@datalayer/cells`` gives; both read the
shared corpus under ``tests/format`` to keep it so.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

FORMAT_VERSION = 1

#: The errors a cell can hold, as Excel spells them (``#CYCLE!`` and ``#BUSY!`` are Cells').
CELL_ERRORS = (
    "#DIV/0!",
    "#REF!",
    "#NAME?",
    "#VALUE!",
    "#N/A",
    "#NUM!",
    "#NULL!",
    "#CYCLE!",
    "#BUSY!",
    "#SPILL!",
)

STYLE_KEYS = (
    "font",
    "size",
    "bold",
    "italic",
    "underline",
    "strike",
    "color",
    "fill",
    "align",
    "valign",
    "wrap",
    "borders",
    "format",
)

_COLORS = {"black", "blue", "cyan", "green", "magenta", "red", "white", "yellow"}
_CONDITION = re.compile(r"^(<=|>=|<>|<|>|=)-?\d+(\.\d+)?$")


def check_format_code(code: str) -> None:
    """Raise a sentence when a number format code does not compile, as the TypeScript compiler refuses it."""
    sections = []
    cur = ""
    i = 0
    while i < len(code):
        c = code[i]
        if c == '"':
            end = code.find('"', i + 1)
            if end < 0:
                raise FormatError(f"'{code}' opens a quote it never closes.")
            cur += code[i : end + 1]
            i = end + 1
            continue
        if c == "[":
            end = code.find("]", i + 1)
            if end < 0:
                raise FormatError(f"'{code}' opens a bracket it never closes.")
            inner = code[i + 1 : end]
            lower = inner.lower()
            if not (
                lower in _COLORS
                or re.fullmatch(r"color\d+", lower)
                or _CONDITION.match(inner)
                or re.fullmatch(r"h+|m+|s+", lower)
                or inner.startswith("$")
            ):
                raise FormatError(f"'{code}': [{inner}] is not a colour, a condition or an elapsed time.")
            cur += code[i : end + 1]
            i = end + 1
            continue
        if c in "\\_*":
            if i + 1 >= len(code):
                raise FormatError(f"'{code}' ends with {c} and nothing after it.")
            cur += code[i : i + 2]
            i += 2
            continue
        if c == ";":
            sections.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    sections.append(cur)
    if len(sections) > 4:
        raise FormatError(f"'{code}' has {len(sections)} sections; a format has at most four.")
    for section in sections:
        plain = re.sub(r'"[^"]*"|\[[^\]]*\]|[\\_*].', "", section)
        if re.search(r"[ymdhsYMDHS]", re.sub(r"(?i)general|am/pm|a/p", "", plain)):
            continue
        if re.search(r"[0#?][^/]*/", plain):
            raise FormatError(f"'{code}': fractions (# ?/?) are not supported yet.")


#: Excel's grid, as the TypeScript model's default limits.
DEFAULT_LIMITS = {"rows": 1_048_576, "cols": 16_384}

_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")


class FormatError(ValueError):
    """A file refused: the message names the path of the first bad field."""


def _fail(path: str, message: str) -> None:
    raise FormatError(f"{path}: {message}")


def _js(value: Any) -> str:
    """What JavaScript's JSON.stringify prints, for messages that quote a value."""
    if isinstance(value, float) and value.is_integer() and not isinstance(value, bool):
        return str(int(value))
    if value is None:
        return "undefined"
    return json.dumps(value, separators=(",", ":"))


def _is_object(x: Any) -> bool:
    return isinstance(x, dict)


def _is_int(x: Any) -> bool:
    return (isinstance(x, int) and not isinstance(x, bool)) or (isinstance(x, float) and x.is_integer())


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _is_index(key: str, maximum: int) -> bool:
    return bool(_INDEX.match(key)) and int(key) < maximum


def check_style(style: Any, where: str = "style") -> None:
    if not _is_object(style):
        _fail(where, "a style is an object.")
    for key in style:
        if key not in STYLE_KEYS:
            raise FormatError(f"{where}: '{key}' is not a style property ({', '.join(STYLE_KEYS)}).")
    for key in ("bold", "italic", "underline", "strike", "wrap"):
        if key in style and not isinstance(style[key], bool):
            raise FormatError(f"{where}.{key}: true or false.")
    for key in ("font", "color", "fill", "format"):
        if key in style and not isinstance(style[key], str):
            raise FormatError(f"{where}.{key}: a string.")
    if "format" in style:
        if not isinstance(style["format"], str):
            raise FormatError(f"{where}.format: a string.")
        try:
            check_format_code(style["format"])
        except FormatError as error:
            raise FormatError(f"{where}.format: {error}") from error
    if "size" in style and not (_is_number(style["size"]) and style["size"] > 0):
        raise FormatError(f"{where}.size: a positive number.")
    if "align" in style and style["align"] not in ("left", "center", "right"):
        raise FormatError(f"{where}.align: left, center or right.")
    if "valign" in style and style["valign"] not in ("top", "middle", "bottom"):
        raise FormatError(f"{where}.valign: top, middle or bottom.")


def _check_value(v: Any, path: str) -> None:
    if v is None or isinstance(v, (str, bool)):
        return
    if _is_number(v):
        if not math.isfinite(v):
            _fail(path, f"{v} is not a value")
        return
    if _is_object(v) and isinstance(v.get("error"), str) and len(v) == 1:
        if v["error"] not in CELL_ERRORS:
            _fail(path, f"'{v['error']}' is not an error code")
        return
    _fail(path, f"{_js(v)} is not a value (a number, a string, a boolean, null or {{ error }})")


def _check_zone(z: Any, path: str, limits: dict[str, int]) -> None:
    if not _is_object(z):
        _fail(path, "a zone is { top, left, bottom, right }")
    for k in ("top", "left", "bottom", "right"):
        if not _is_int(z.get(k)) or z[k] < 0:
            _fail(f"{path}.{k}", "a non-negative integer")
    if z["top"] > z["bottom"] or z["left"] > z["right"]:
        _fail(path, "top-left after bottom-right")
    if z["bottom"] >= limits["rows"] or z["right"] >= limits["cols"]:
        _fail(path, "outside the sheet")


def validate_workbook(data: Any, limits: dict[str, int] | None = None) -> dict[str, Any]:
    """Return ``data`` when it is a valid CellsWorkbook; raise :class:`FormatError` otherwise."""
    limits = limits or DEFAULT_LIMITS
    if not _is_object(data):
        _fail("workbook", "a CellsWorkbook is a JSON object")
    if data.get("version") != FORMAT_VERSION or isinstance(data.get("version"), bool):
        _fail("version", f"this is format version {_js(data.get('version'))}; Cells reads version {FORMAT_VERSION}")
    styles = data.get("styles", [])
    if not isinstance(styles, list):
        _fail("styles", "a list")
    for i, s in enumerate(styles):
        check_style(s, f"styles[{i}]")
    if styles and len(styles[0]) > 0:
        _fail("styles[0]", "style 0 is the default: {}")
    sheets = data.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        _fail("sheets", "a non-empty list")
    ids: set[str] = set()
    names: set[str] = set()
    for i, sheet in enumerate(sheets):
        p = f"sheets[{i}]"
        if not _is_object(sheet):
            _fail(p, "a sheet is an object")
        sid = sheet.get("id")
        if not isinstance(sid, str) or sid == "":
            _fail(f"{p}.id", "a non-empty string")
        if sid in ids:
            _fail(f"{p}.id", f"'{sid}' is used twice")
        ids.add(sid)
        name = sheet.get("name")
        if not isinstance(name, str) or name.strip() == "":
            _fail(f"{p}.name", "a non-empty string")
        if name.lower() in names:
            _fail(f"{p}.name", f"'{name}' is used twice")
        names.add(name.lower())
        rows = sheet.get("rows")
        if not _is_object(rows):
            _fail(f"{p}.rows", "an object keyed by row index")
        for r, row in rows.items():
            rp = f'{p}.rows["{r}"]'
            if not _is_index(r, limits["rows"]):
                _fail(rp, f"'{r}' is not a row index below {limits['rows']}")
            if not _is_object(row) or not _is_object(row.get("cells")):
                _fail(rp, "a row is { cells: { … } }")
            for c, cell in row["cells"].items():
                cp = f'{rp}.cells["{c}"]'
                if not _is_index(c, limits["cols"]):
                    _fail(cp, f"'{c}' is not a column index below {limits['cols']}")
                if not _is_object(cell):
                    _fail(cp, "a cell is { v?, f?, s? }")
                for k in cell:
                    if k not in ("v", "f", "s"):
                        _fail(f"{cp}.{k}", "a cell has v, f and s only")
                if "v" in cell:
                    _check_value(cell["v"], f"{cp}.v")
                if "f" in cell and (not isinstance(cell["f"], str) or cell["f"] == ""):
                    _fail(f"{cp}.f", "a formula without the =")
                if "s" in cell:
                    s = cell["s"]
                    if not _is_int(s) or s < 0 or s >= max(1, len(styles)):
                        _fail(f"{cp}.s", f"no style {_js(s)}")
        charts = sheet.get("charts")
        if charts is not None:
            from .charts import check_chart  # local: charts imports this module

            if not _is_object(charts):
                _fail(f"{p}.charts", "an object of charts by id")
            for cid, chart in charts.items():
                check_chart(chart, f'{p}.charts["{cid}"]', limits)
                if chart["id"] != cid:
                    _fail(f'{p}.charts["{cid}"].id', f"'{chart['id']}' is not the key '{cid}'")
        sizes = sheet.get("sizes")
        if sizes is not None:
            if not _is_object(sizes):
                _fail(f"{p}.sizes", "{ rows?, cols? }")
            for axis in ("rows", "cols"):
                if axis not in sizes:
                    continue
                if not _is_object(sizes[axis]):
                    _fail(f"{p}.sizes.{axis}", "an object keyed by index")
                for k, v in sizes[axis].items():
                    if not _is_index(k, limits[axis]):
                        _fail(f'{p}.sizes.{axis}["{k}"]', "not an index of the sheet")
                    if not (_is_number(v) and v > 0 and math.isfinite(v)):
                        _fail(f'{p}.sizes.{axis}["{k}"]', "a positive size")
        hidden = sheet.get("hidden")
        if hidden is not None:
            if not _is_object(hidden):
                _fail(f"{p}.hidden", "{ rows?, cols? }")
            for axis in ("rows", "cols"):
                if axis not in hidden:
                    continue
                if not isinstance(hidden[axis], list):
                    _fail(f"{p}.hidden.{axis}", "a list of indexes")
                for j, x in enumerate(hidden[axis]):
                    if not _is_int(x) or x < 0 or x >= limits[axis]:
                        _fail(f"{p}.hidden.{axis}[{j}]", "not an index of the sheet")
        merges = sheet.get("merges")
        if merges is not None:
            if not isinstance(merges, list):
                _fail(f"{p}.merges", "a list of zones")
            for j, z in enumerate(merges):
                _check_zone(z, f"{p}.merges[{j}]", limits)
        frozen = sheet.get("frozen")
        if frozen is not None:
            ok = (
                _is_object(frozen)
                and _is_int(frozen.get("rows"))
                and _is_int(frozen.get("cols"))
                and frozen["rows"] >= 0
                and frozen["cols"] >= 0
            )
            if not ok:
                _fail(f"{p}.frozen", "{ rows, cols }, non-negative integers")
    return data
