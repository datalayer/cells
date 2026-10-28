# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""A workbook as an agent reads and writes it: values and formulas by A1 reference.

    wb = Workbook.load("budget.cells.json")
    wb.read("Summary!A1:C4")              # rows of values
    wb.write("B2", [[12, "=B1*2"]])       # a block from B2
    wb.save("budget.cells.json")

Formulas are kept as typed and are not evaluated here, as in the TypeScript
model until its formula engine lands: reading a formula cell gives its cached
value, ``None`` when it has none.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Union

from .format import CELL_ERRORS, DEFAULT_LIMITS, FORMAT_VERSION, FormatError, check_style, validate_workbook

Value = Union[float, int, str, bool, None, dict]

_CELL = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$")


def column_index(letters: str) -> int:
    """``A`` → 0, ``AA`` → 26."""
    if not re.fullmatch(r"[A-Za-z]{1,3}", letters):
        raise ValueError(f"'{letters}' is not a column (A to XFD).")
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def column_letters(col: int) -> str:
    """0 → ``A``, 26 → ``AA``."""
    if col < 0:
        raise ValueError(f"No column at index {col}.")
    name = ""
    n = col + 1
    while n > 0:
        n, rest = divmod(n - 1, 26)
        name = chr(65 + rest) + name
    return name


def parse_a1(text: str) -> tuple[int, int]:
    """``B3`` → (row 2, col 1)."""
    m = _CELL.match(text.strip())
    if not m:
        raise ValueError(f"'{text}' is not a cell reference such as B3.")
    return int(m.group(2)) - 1, column_index(m.group(1))


def split_sheet(ref: str) -> tuple[str | None, str]:
    """``'My sheet'!A1:B2`` → (``My sheet``, ``A1:B2``)."""
    bang = ref.rfind("!")
    if bang < 0:
        return None, ref
    sheet = ref[:bang]
    if sheet.startswith("'"):
        if not sheet.endswith("'") or len(sheet) < 2:
            raise ValueError(f"'{ref}' has an unclosed sheet name.")
        sheet = sheet[1:-1].replace("''", "'")
    if sheet == "":
        raise ValueError(f"'{ref}' names an empty sheet.")
    return sheet, ref[bang + 1 :]


def parse_zone(text: str) -> tuple[int, int, int, int]:
    """``A1:C4`` → (top, left, bottom, right), 0-based and inclusive."""
    parts = text.strip().split(":")
    if len(parts) > 2 or parts[0] == "":
        raise ValueError(f"'{text}' is not a range such as A1:C4.")
    r0, c0 = parse_a1(parts[0])
    r1, c1 = parse_a1(parts[1]) if len(parts) == 2 else (r0, c0)
    return min(r0, r1), min(c0, c1), max(r0, r1), max(c0, c1)


def is_error(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"error"} and value["error"] in CELL_ERRORS


def parse_input(text: str) -> dict[str, Any]:
    """What typing ``text`` into a cell means, as the TypeScript ``parseInput``: a cell's ``v`` or ``f``."""
    if text.startswith("'"):
        return {"v": text[1:]}
    if text.startswith("=") and len(text) > 1:
        return {"f": text[1:]}
    t = text.strip()
    if t and re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", t):
        n = float(t)
        return {"v": int(n) if n.is_integer() and "." not in t and "e" not in t.lower() else n}
    if t.lower() == "true":
        return {"v": True}
    if t.lower() == "false":
        return {"v": False}
    return {} if text == "" else {"v": text}


class Workbook:
    """A CellsWorkbook in memory: sheets of sparse cells, styles by index."""

    def __init__(self, data: dict[str, Any]):
        validate_workbook(data)
        self._styles: list[dict[str, Any]] = [dict(s) for s in data.get("styles", [])] or [{}]
        self._sheets: list[dict[str, Any]] = []
        for s in data["sheets"]:
            cells: dict[tuple[int, int], dict[str, Any]] = {}
            for r, row in s["rows"].items():
                for c, cell in row["cells"].items():
                    kept = {k: v for k, v in cell.items() if not (k == "v" and v is None)}
                    if kept.get("s") == 0:
                        kept.pop("s")
                    if kept:
                        cells[(int(r), int(c))] = kept
            sheet = {k: v for k, v in s.items() if k != "rows"}
            sheet["cells"] = cells
            self._sheets.append(sheet)

    # ------------------------------------------------------------------ files

    @classmethod
    def load(cls, path: Union[str, Path]) -> "Workbook":
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise FormatError(f"workbook: {path} is not JSON ({error})") from error
        return cls(data)

    @classmethod
    def from_rows(cls, rows: list[list[Value]], name: str = "Sheet1") -> "Workbook":
        """A workbook of one sheet from rows of values."""
        out: dict[str, Any] = {}
        for r, row in enumerate(rows):
            for c, v in enumerate(row):
                if v is not None:
                    out.setdefault(str(r), {"cells": {}})["cells"][str(c)] = {"v": v}
        return cls({"version": FORMAT_VERSION, "sheets": [{"id": "s1", "name": name, "rows": out}], "styles": []})

    def save(self, path: Union[str, Path]) -> None:
        Path(path).write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8")

    def to_json(self) -> dict[str, Any]:
        """The workbook as CellsWorkbook JSON, in the TypeScript model's canonical form."""
        used: dict[int, int] = {0: 0}
        styles: list[dict[str, Any]] = [{}]
        sheets = []
        for sheet in self._sheets:
            rows: dict[str, Any] = {}
            for (r, c) in sorted(sheet["cells"]):
                cell = sheet["cells"][(r, c)]
                out: dict[str, Any] = {}
                if cell.get("v") is not None:
                    out["v"] = cell["v"]
                if "f" in cell:
                    out["f"] = cell["f"]
                s = cell.get("s", 0)
                if s != 0:
                    if s not in used:
                        used[s] = len(styles)
                        styles.append(self._styles[s])
                    out["s"] = used[s]
                rows.setdefault(str(r), {"cells": {}})["cells"][str(c)] = out
            item: dict[str, Any] = {"id": sheet["id"], "name": sheet["name"], "rows": rows}
            for key in ("sizes", "hidden", "merges", "frozen", "charts"):
                if key in sheet and sheet[key]:
                    if key == "frozen" and sheet[key] == {"rows": 0, "cols": 0}:
                        continue
                    item[key] = sheet[key]
            sheets.append(item)
        return {"version": FORMAT_VERSION, "sheets": sheets, "styles": styles}

    # ------------------------------------------------------------------ reading

    @property
    def sheet_names(self) -> list[str]:
        return [s["name"] for s in self._sheets]

    def _sheet(self, name: str | None) -> dict[str, Any]:
        if name is None:
            return self._sheets[0]
        for s in self._sheets:
            if s["name"].lower() == name.lower():
                return s
        raise KeyError(f"No sheet '{name}'; the workbook has {', '.join(self.sheet_names)}.")

    def _zone(self, ref: str) -> tuple[dict[str, Any], tuple[int, int, int, int]]:
        name, a1 = split_sheet(ref)
        sheet = self._sheet(name)
        zone = parse_zone(a1)
        if zone[2] >= DEFAULT_LIMITS["rows"] or zone[3] >= DEFAULT_LIMITS["cols"]:
            raise ValueError(f"'{ref}' reaches outside the sheet.")
        return sheet, zone

    def cell(self, ref: str) -> dict[str, Any] | None:
        """What a cell holds: ``{'v': …}``, ``{'f': …, 'v': cached}``, with ``'s'`` for a style; ``None`` when empty."""
        sheet, (r, c, r1, c1) = self._zone(ref)
        if (r, c) != (r1, c1):
            raise ValueError(f"'{ref}' is a range; cell() takes one cell.")
        found = sheet["cells"].get((r, c))
        return dict(found) if found else None

    def read(self, ref: str) -> list[list[Value]]:
        """The values a range shows, as rows: a formula shows its cached value."""
        sheet, (top, left, bottom, right) = self._zone(ref)
        cells = sheet["cells"]
        return [[(cells.get((r, c)) or {}).get("v") for c in range(left, right + 1)] for r in range(top, bottom + 1)]

    def formulas(self, ref: str) -> list[list[str | None]]:
        """The formulas of a range as typed (with ``=``), ``None`` where a cell holds none."""
        sheet, (top, left, bottom, right) = self._zone(ref)
        cells = sheet["cells"]
        out = []
        for r in range(top, bottom + 1):
            row = []
            for c in range(left, right + 1):
                f = (cells.get((r, c)) or {}).get("f")
                row.append(None if f is None else f"={f}")
            out.append(row)
        return out

    # ------------------------------------------------------------------ writing

    def write(self, ref: str, rows: list[list[Any]]) -> None:
        """Write a block of rows from the top-left of ``ref``. A string starting with ``=`` is a formula;
        ``None`` empties a cell's content and keeps its style."""
        sheet, (top, left, _, _) = self._zone(ref)
        if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
            raise ValueError("write takes a non-empty list of rows.")
        width = max(len(r) for r in rows)
        if top + len(rows) > DEFAULT_LIMITS["rows"] or left + width > DEFAULT_LIMITS["cols"]:
            raise ValueError(f"The block at '{ref}' reaches outside the sheet.")
        planned: dict[tuple[int, int], dict[str, Any] | None] = {}
        for dr, row in enumerate(rows):
            for dc, value in enumerate(row):
                pos = (top + dr, left + dc)
                previous = sheet["cells"].get(pos, {})
                cell: dict[str, Any] = {"s": previous["s"]} if "s" in previous else {}
                if isinstance(value, str) and value.startswith("=") and len(value) > 1:
                    cell["f"] = value[1:]
                elif value is not None:
                    if isinstance(value, float) and not math.isfinite(value):
                        raise ValueError(f"{value} is not a cell value.")
                    if isinstance(value, dict) and not is_error(value):
                        raise ValueError(f"{value!r} is not a cell value (an error is {{'error': '#N/A'}}).")
                    if not isinstance(value, (int, float, str, bool, dict)):
                        raise ValueError(f"{value!r} is not a cell value.")
                    cell["v"] = value
                planned[pos] = cell or None
        for pos, cell in planned.items():
            if cell is None:
                sheet["cells"].pop(pos, None)
            else:
                sheet["cells"][pos] = cell

    def clear(self, ref: str) -> None:
        """Empty a range: values, formulas and styles."""
        sheet, (top, left, bottom, right) = self._zone(ref)
        for pos in [p for p in sheet["cells"] if top <= p[0] <= bottom and left <= p[1] <= right]:
            del sheet["cells"][pos]

    def style(self, ref: str, style: dict[str, Any] | None) -> None:
        """Merge ``style`` into every cell of a range (``None`` resets to the default)."""
        if style is not None:
            check_style(style)
        sheet, (top, left, bottom, right) = self._zone(ref)
        for r in range(top, bottom + 1):
            for c in range(left, right + 1):
                cell = dict(sheet["cells"].get((r, c), {}))
                if style is None:
                    cell.pop("s", None)
                else:
                    merged = {**self._styles[cell.get("s", 0)], **style}
                    merged = {k: v for k, v in merged.items() if v is not False}
                    cell["s"] = self._intern(merged)
                    if cell["s"] == 0:
                        cell.pop("s")
                if cell:
                    sheet["cells"][(r, c)] = cell
                else:
                    sheet["cells"].pop((r, c), None)

    # ------------------------------------------------------------------ charts (§3.12)

    def charts(self, sheet: str | None = None) -> list[dict[str, Any]]:
        """The charts of a sheet (the first by default), as their specs."""
        return [dict(c) for c in self._sheet(sheet).get("charts", {}).values()]

    def _chart_sheet_and_zone(self, ref: str, default: dict[str, Any]) -> tuple[dict[str, Any], tuple[int, int, int, int]]:
        name, zone = split_sheet(ref)
        sheet = self._sheet(name) if name is not None else default
        return sheet, parse_zone(zone)

    def _points_and_numbers(self, sheet: dict[str, Any], spec: dict[str, Any]) -> tuple[int, bool]:
        from .charts import ref_zone

        points = 0
        numeric = False
        for s in spec["data"]["series"]:
            found = ref_zone(s["values"])
            if found is None:
                continue
            target = self._sheet(found[0]) if found[0] is not None else sheet
            top, left, bottom, right = found[1]
            points += (bottom - top + 1) * (right - left + 1)
            if not numeric:
                for (r, c), cell in target["cells"].items():
                    v = cell.get("v")
                    if top <= r <= bottom and left <= c <= right and isinstance(v, (int, float)) and not isinstance(v, bool):
                        numeric = True
                        break
        return points, numeric

    def _check_chart_content(self, sheet: dict[str, Any], spec: dict[str, Any]) -> None:
        from .charts import MAX_CHART_POINTS, ChartRefusal, chart_problem

        problem = chart_problem(spec, DEFAULT_LIMITS)
        if problem is not None:
            raise ChartRefusal("InvalidArgument", problem)
        points, numeric = self._points_and_numbers(sheet, spec)
        if points > MAX_CHART_POINTS:
            raise ChartRefusal(
                "ChartTooLarge", f"A chart holds at most {MAX_CHART_POINTS:,} points; this one has {points:,}."
            )
        if not numeric:
            raise ChartRefusal("NoNumericData", "The chart’s ranges hold no number to draw.")

    def add_chart(
        self,
        type: str,
        data: str,
        anchor: str,
        title: str | None = None,
        legend: str = "bottom",
        variant: str | None = None,
        id: str | None = None,
        sheet: str | None = None,
    ) -> dict[str, Any]:
        """Add a chart of ``type`` from the cells of ``data`` (``Sheet1!A1:C13``, inferred as the
        TypeScript core infers a selection), anchored on the cells of ``anchor`` (``E2:L18``);
        returns its spec. Refusals are :class:`ChartRefusal` with the core's reasons."""
        from .charts import ChartRefusal, infer_chart_data

        target = self._sheet(sheet)
        source, zone = self._chart_sheet_and_zone(data, target)
        cells = source["cells"]
        inferred = infer_chart_data(lambda r, c: (cells.get((r, c)) or {}).get("v"), source["name"], zone)
        _, (top, left, bottom, right) = self._chart_sheet_and_zone(anchor, target)
        charts = target.setdefault("charts", {})
        if id is None:
            n = 1
            while f"chart{n}" in charts:
                n += 1
            id = f"chart{n}"
        elif id in charts:
            raise ChartRefusal("DuplicateChart", f"A chart '{id}' is on this sheet already.")
        spec: dict[str, Any] = {
            "id": id,
            "type": type,
            "anchor": {
                "kind": "cells",
                "from": {"row": top, "col": left, "dx": 0, "dy": 0},
                "to": {"row": bottom + 1, "col": right + 1, "dx": 0, "dy": 0},
            },
            "data": inferred,
            "legend": legend,
        }
        if variant is not None:
            spec["variant"] = variant
        if title is not None:
            spec["title"] = title
        self._check_chart_content(target, spec)
        charts[id] = spec
        return dict(spec)

    def update_chart(self, id: str, sheet: str | None = None, **changes: Any) -> dict[str, Any]:
        """Change a chart's type, variant, data, title, legend, axes or labels; returns the new spec."""
        from .charts import ChartRefusal

        target = self._sheet(sheet)
        charts = target.get("charts", {})
        if id not in charts:
            raise ChartRefusal("UnknownChart", f"No chart '{id}' on this sheet.")
        if "id" in changes or "anchor" in changes:
            raise ChartRefusal("InvalidArgument", "An update changes neither the id nor the anchor (MOVE_CHART, RESIZE_CHART).")
        spec = {**charts[id], **{k: v for k, v in changes.items() if v is not None}}
        for k, v in changes.items():
            if v is None:
                spec.pop(k, None)
        self._check_chart_content(target, spec)
        charts[id] = spec
        return dict(spec)

    def remove_chart(self, id: str, sheet: str | None = None) -> None:
        from .charts import ChartRefusal

        charts = self._sheet(sheet).get("charts", {})
        if id not in charts:
            raise ChartRefusal("UnknownChart", f"No chart '{id}' on this sheet.")
        del charts[id]

    def add_sheet(self, name: str) -> None:
        if not name.strip() or len(name) > 31 or re.search(r"[\\/?*\[\]:]", name):
            raise ValueError(f"'{name}' is not a sheet name.")
        if any(s["name"].lower() == name.lower() for s in self._sheets):
            raise ValueError(f"A sheet is called '{name}' already.")
        ids = {s["id"] for s in self._sheets}
        n = 1
        while f"s{n}" in ids:
            n += 1
        self._sheets.append({"id": f"s{n}", "name": name, "cells": {}})

    def _intern(self, style: dict[str, Any]) -> int:
        canonical = {k: style[k] for k in sorted(style)}
        for i, s in enumerate(self._styles):
            if {k: s[k] for k in sorted(s)} == canonical:
                return i
        self._styles.append(canonical)
        return len(self._styles) - 1
