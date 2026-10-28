# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The live workbook (§3.13, C11-09): what Python code in a cell reads and writes.

``LiveWorkbook`` is the API — ``cells["A1:B7"]`` as a DataFrame, ``cells["C2"] = 42``,
``cells["E1:F3"] = df`` spilling, ``on_change`` — over a *store*, the document the
kernel holds:

- ``LoroStore``: the collaboration document itself, a ``loro.LoroDoc`` in the
  ``cells:<sheetId>`` schema of the TypeScript binding (``src/collab/binding.ts``,
  ``src/collab/axis.ts``): a peer like any other, its writes collaboration
  patches. Needs ``loro`` (loro-py), which has wheels for CPython on every
  desktop and server platform.
- ``JsonStore``: for a kernel where loro-py cannot run (the browser's Pyodide):
  the page sends ``CellsWorkbook`` JSON over the comm and applies the writes the
  kernel sends back. The same API, one format less faithful.

The transports (``datalayer_cells.transport``) feed a store its updates and
carry its own out.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from .workbook import column_index, column_letters, parse_zone, split_sheet

try:  # pragma: no cover - depends on the environment
    import loro as _loro
except ImportError:  # pragma: no cover
    _loro = None

#: The default limits of a sheet, as the TypeScript model's (``DEFAULT_LIMITS``).
DEFAULT_LIMITS = {"rows": 1_048_576, "cols": 16_384}

#: The sheet a document with no sheet list shows, as the TypeScript binding names it.
EMPTY_SHEET = "empty"

Value = int | float | str | bool | None | dict


class SpillError(ValueError):
    """A spill refused: the cells it would cover hold something, or lie outside the sheet (``#SPILL!``)."""


# ----------------------------------------------------------------- the axis order


def implicit_id(index: int) -> str:
    """The id an index holds before any edit names it: ``b<index in base 36>``."""
    return "b" + _base36(index)


def implicit_key(index: int) -> str:
    """The order key of an implicit id."""
    return "1" + _base36(index).rjust(5, "0")


_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    out = ""
    while n > 0:
        n, r = divmod(n, 36)
        out = _DIGITS[r] + out
    return out


def implicit_index(cell_id: str) -> int | None:
    """The index an implicit id names, or ``None`` for a fresh id."""
    if re.fullmatch(r"b[0-9a-z]+", cell_id) is None:
        return None
    return int(cell_id[1:], 36)


def _implicit_before(key: str) -> int:
    if key[:1] == "0":
        return 0
    if key[:1] != "1":
        return 2**53
    head = key[1:6].ljust(5, "0")
    return int(head, 36) + (1 if len(key) > 6 else 0)


class AxisOrder:
    """The live order of an axis's ids: the explicit entries of its map, sorted by key, among the untouched implicit ones.

    A port of ``AxisOrder`` in ``src/collab/axis.ts``: the two must agree, so a
    position here is the same row on the page.
    """

    def __init__(self, entries: dict[str, dict[str, Any]], count: int):
        self.count = count
        explicit: list[tuple[str, str]] = []
        touched: list[int] = []
        for cell_id, e in entries.items():
            index = implicit_index(cell_id)
            if index is not None:
                touched.append(index)
            if not e.get("deleted") and e.get("key") is not None:
                explicit.append((e["key"], cell_id))
        explicit.sort()
        self._explicit = [(cid, key) for key, cid in explicit]
        self._touched = sorted(touched)

    def _touched_below(self, index: int) -> int:
        n = 0
        for x in self._touched:
            if x < index:
                n += 1
            else:
                break
        return n

    def _untouched_before(self, key: str) -> int:
        n = _implicit_before(key)
        return n - self._touched_below(n)

    def _untouched_at(self, rank: int) -> int:
        i = rank
        for x in self._touched:
            if x <= i:
                i += 1
            else:
                break
        return i

    def id_at(self, position: int) -> str | None:
        """The id at a live position."""
        if position < 0:
            return None
        for k, (cell_id, key) in enumerate(self._explicit):
            before = self._untouched_before(key) + k
            if position < before:
                return implicit_id(self._untouched_at(position - k))
            if position == before:
                return cell_id
        return implicit_id(self._untouched_at(position - len(self._explicit)))

    def position_of(self, cell_id: str) -> int | None:
        """The live position of an id, or ``None`` when it is deleted (or never was)."""
        for k, (cid, key) in enumerate(self._explicit):
            if cid == cell_id:
                return self._untouched_before(key) + k
        i = implicit_index(cell_id)
        if i is None or i in self._touched:
            return None
        key = implicit_key(i)
        e = 0
        while e < len(self._explicit) and self._explicit[e][1] < key:
            e += 1
        return i - self._touched_below(i) + e


# ----------------------------------------------------------------- the stores


@dataclass
class Zone:
    """A rectangle of cells, inclusive, 0-based."""

    top: int
    left: int
    bottom: int
    right: int

    @property
    def rows(self) -> int:
        return self.bottom - self.top + 1

    @property
    def cols(self) -> int:
        return self.right - self.left + 1


class Store:
    """What a live workbook reads and writes: sheets, values by position, changes."""

    def sheet_ids(self) -> list[str]:
        raise NotImplementedError

    def sheet_name(self, sheet: str) -> str:
        raise NotImplementedError

    def values(self, sheet: str, zone: Zone) -> list[list[Value]]:
        raise NotImplementedError

    def used_zone(self, sheet: str) -> Zone | None:
        raise NotImplementedError

    def write(self, sheet: str, cells: dict[tuple[int, int], Value], origin: str) -> None:
        raise NotImplementedError

    def subscribe(self, callback: Callable[[], None]) -> Callable[[], None]:
        raise NotImplementedError


class LoroStore(Store):
    """The collaboration document, read and written in the TypeScript binding's schema."""

    def __init__(self, doc: Any = None, limits: dict[str, int] | None = None):
        if _loro is None:
            raise ImportError("The live workbook over the collaboration document needs loro-py: pip install loro")
        self.doc = doc if doc is not None else _loro.LoroDoc()
        self.limits = dict(DEFAULT_LIMITS, **(limits or {}))
        self._listeners: list[Callable[[], None]] = []
        # loro-py keeps a subscription while its callback answers True.
        self._sub = self.doc.subscribe_root(lambda _event: self._changed())

    def _changed(self) -> bool:
        for listener in list(self._listeners):
            listener()
        return True

    # -- reading

    def sheet_ids(self) -> list[str]:
        ids = [x for x in self.doc.get_movable_list("sheets").get_value() if isinstance(x, str)]
        return ids or [EMPTY_SHEET]

    def sheet_name(self, sheet: str) -> str:
        name = self.doc.get_map(f"sheet:{sheet}").get_value().get("name")
        return name if isinstance(name, str) else "Sheet1"

    def _order(self, sheet: str, axis: str) -> AxisOrder:
        entries = self.doc.get_map(f"{axis}:{sheet}").get_value()
        return AxisOrder({k: v for k, v in entries.items() if isinstance(v, dict)}, self.limits[axis])

    def _positions(self, sheet: str) -> dict[tuple[int, int], dict[str, Any]]:
        rows = self._order(sheet, "rows")
        cols = self._order(sheet, "cols")
        out: dict[tuple[int, int], dict[str, Any]] = {}
        for key, stored in self.doc.get_map(f"cells:{sheet}").get_value().items():
            if not isinstance(stored, dict):
                continue
            r_id, _, c_id = key.partition(".")
            r = rows.position_of(r_id)
            c = cols.position_of(c_id)
            if r is None or c is None:
                continue
            out[(r, c)] = stored
        return out

    def values(self, sheet: str, zone: Zone) -> list[list[Value]]:
        cells = self._positions(sheet)
        return [
            [_value_of(cells.get((r, c))) for c in range(zone.left, zone.right + 1)]
            for r in range(zone.top, zone.bottom + 1)
        ]

    def used_zone(self, sheet: str) -> Zone | None:
        cells = self._positions(sheet)
        if not cells:
            return None
        rs = [r for r, _ in cells]
        cs = [c for _, c in cells]
        return Zone(min(rs), min(cs), max(rs), max(cs))

    # -- writing

    def write(self, sheet: str, cells: dict[tuple[int, int], Value], origin: str) -> None:
        rows = self._order(sheet, "rows")
        cols = self._order(sheet, "cols")
        table = self.doc.get_map(f"cells:{sheet}")
        current = table.get_value()
        for (r, c), value in cells.items():
            key = f"{rows.id_at(r)}.{cols.id_at(c)}"
            stored = current.get(key) if isinstance(current.get(key), dict) else {}
            kept = {k: v for k, v in stored.items() if k == "s"}
            if value is None:
                if kept:
                    table.insert(key, kept)
                elif key in current:
                    table.delete(key)
            else:
                table.insert(key, {**kept, "v": value})
        self.doc.set_next_commit_message(origin)
        self.doc.commit()

    def subscribe(self, callback: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(callback)
        return lambda: self._listeners.remove(callback)

    # -- the transport's side

    def snapshot(self) -> bytes:
        """The document as a snapshot, for a peer joining."""
        return self.doc.export(_loro.ExportMode.Snapshot())

    def apply(self, update: bytes) -> None:
        """Merge a peer's update or snapshot."""
        self.doc.import_(update)

    def on_local_update(self, callback: Callable[[bytes], None]) -> Any:
        """Be told of this document's own updates, as bytes a peer imports."""

        def keep(update: bytes) -> bool:
            callback(bytes(update))
            return True

        return self.doc.subscribe_local_update(keep)


def _value_of(stored: dict[str, Any] | None) -> Value:
    if stored is None:
        return None
    v = stored.get("v")
    if isinstance(v, dict) and "error" in v:
        return {"error": v["error"]}
    return v


class JsonStore(Store):
    """A ``CellsWorkbook`` JSON the page keeps sending, for a kernel without loro-py (Pyodide); writes queue for the page."""

    def __init__(self, workbook: dict[str, Any] | None = None):
        self.workbook: dict[str, Any] = workbook or {"version": 1, "sheets": [{"id": "s1", "name": "Sheet1", "rows": {}}]}
        self._listeners: list[Callable[[], None]] = []
        self.outbox: list[dict[str, Any]] = []
        self.send: Callable[[dict[str, Any]], None] | None = None

    def replace(self, workbook: dict[str, Any]) -> None:
        """The page sent the workbook again."""
        self.workbook = workbook
        for listener in list(self._listeners):
            listener()

    def _sheet(self, sheet: str) -> dict[str, Any]:
        for s in self.workbook["sheets"]:
            if s["id"] == sheet:
                return s
        raise KeyError(f"No sheet '{sheet}'.")

    def sheet_ids(self) -> list[str]:
        return [s["id"] for s in self.workbook["sheets"]]

    def sheet_name(self, sheet: str) -> str:
        return self._sheet(sheet)["name"]

    def values(self, sheet: str, zone: Zone) -> list[list[Value]]:
        rows = self._sheet(sheet)["rows"]
        out = []
        for r in range(zone.top, zone.bottom + 1):
            cells = rows.get(str(r), {}).get("cells", {})
            out.append([_value_of(cells.get(str(c))) for c in range(zone.left, zone.right + 1)])
        return out

    def used_zone(self, sheet: str) -> Zone | None:
        rows = self._sheet(sheet)["rows"]
        positions = [(int(r), int(c)) for r, row in rows.items() for c in row.get("cells", {})]
        if not positions:
            return None
        return Zone(min(r for r, _ in positions), min(c for _, c in positions), max(r for r, _ in positions), max(c for _, c in positions))

    def write(self, sheet: str, cells: dict[tuple[int, int], Value], origin: str) -> None:
        rows = self._sheet(sheet)["rows"]
        for (r, c), value in cells.items():
            row = rows.setdefault(str(r), {"cells": {}})["cells"]
            cell = row.get(str(c), {})
            cell.pop("f", None)
            if value is None:
                cell.pop("v", None)
                if cell:
                    row[str(c)] = cell
                else:
                    row.pop(str(c), None)
            else:
                cell["v"] = value
                row[str(c)] = cell
        message = {
            "type": "write",
            "sheet": sheet,
            "origin": origin,
            "cells": [[r, c, v] for (r, c), v in cells.items()],
        }
        if self.send is not None:
            self.send(message)
        else:
            self.outbox.append(message)

    def subscribe(self, callback: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(callback)
        return lambda: self._listeners.remove(callback)


# ----------------------------------------------------------------- the API


@dataclass
class _Range:
    sheet: str
    zone: Zone


@dataclass
class SheetView:
    """One sheet of the live workbook: its used range as a frame, by name."""

    workbook: "LiveWorkbook"
    sheet: str

    @property
    def name(self) -> str:
        return self.workbook.store.sheet_name(self.sheet)

    def frame(self, header: bool = False) -> Any:
        """The used range as a DataFrame (rows without pandas); ``header``: the first row names the columns."""
        zone = self.workbook.store.used_zone(self.sheet)
        if zone is None:
            return _frame([], header)
        ref = f"{self.name}!{_zone_ref(zone)}"
        return self.workbook._read(ref, header)


@dataclass
class LiveWorkbook:
    """The workbook a kernel is bound to: ``cells[...]`` reads, ``cells[...] = ...`` writes, ``on_change`` follows the page.

    The ranges each run read are recorded between ``begin_run`` and ``end_run``
    and answered to the grid, which makes them the cell's precedents. ``origin``
    names the code cell whose writes these are (``Sheet1!C4``), the attribution
    of the collaboration patches.
    """

    store: Store
    origin: str = "python"
    _reads: list[str] | None = None
    _writes: dict[str, dict[tuple[str, int, int], Value]] = field(default_factory=dict)
    _watchers: list[tuple[_Range, Callable[[Any], None], list]] = field(default_factory=list)

    # -- runs

    def begin_run(self, origin: str | None = None) -> None:
        """Start recording the ranges this run reads; ``origin`` names the cell that runs."""
        self._reads = []
        if origin is not None:
            self.origin = origin

    def end_run(self) -> list[str]:
        """The ranges the run read, as references (``Sheet1!A1:B7``), in order, each once."""
        reads = self._reads or []
        self._reads = None
        return reads

    # -- references

    def _resolve(self, ref: str) -> _Range:
        name, a1 = split_sheet(ref)
        if name is None:
            sheet = self.store.sheet_ids()[0]
        else:
            matches = [s for s in self.store.sheet_ids() if self.store.sheet_name(s) == name]
            if not matches:
                raise KeyError(f"No sheet '{name}'.")
            sheet = matches[0]
        top, left, bottom, right = parse_zone(a1)
        return _Range(sheet, Zone(top, left, bottom, right))

    def _qualified(self, r: _Range) -> str:
        return f"{self.store.sheet_name(r.sheet)}!{_zone_ref(r.zone)}"

    def sheet(self, name: str | None = None) -> SheetView:
        """A sheet by name (the first by default)."""
        if name is None:
            return SheetView(self, self.store.sheet_ids()[0])
        for s in self.store.sheet_ids():
            if self.store.sheet_name(s) == name:
                return SheetView(self, s)
        raise KeyError(f"No sheet '{name}'.")

    # -- reading

    def _read(self, ref: str, header: bool | None = None) -> Any:
        r = self._resolve(ref)
        if self._reads is not None:
            q = self._qualified(r)
            if q not in self._reads:
                self._reads.append(q)
        rows = self.store.values(r.sheet, r.zone)
        if r.zone.rows == 1 and r.zone.cols == 1:
            return rows[0][0]
        return _frame(rows, header)

    def __getitem__(self, ref: str) -> Any:
        """``cells["A1:B7"]``: a DataFrame of the values (rows without pandas); ``cells["C2"]``: the value."""
        return self._read(ref)

    def values(self, ref: str) -> list[list[Value]]:
        """The values of a range as rows, always."""
        r = self._resolve(ref)
        if self._reads is not None:
            q = self._qualified(r)
            if q not in self._reads:
                self._reads.append(q)
        return self.store.values(r.sheet, r.zone)

    # -- writing

    def __setitem__(self, ref: str, value: Any) -> None:
        """``cells["C2"] = 42``; ``cells["E1:F3"] = df`` spills from E1 (refused with ``#SPILL!`` over a non-empty cell)."""
        r = self._resolve(ref)
        rows = _rows_of(value)
        single = r.zone.rows == 1 and r.zone.cols == 1
        if single and len(rows) == 1 and len(rows[0]) == 1:
            self._write(r.sheet, {(r.zone.top, r.zone.left): rows[0][0]})
            return
        height = len(rows)
        width = max((len(row) for row in rows), default=0)
        if height == 0 or width == 0:
            return
        if not single and (height > r.zone.rows or width > r.zone.cols):
            raise SpillError(f"{height} × {width} values do not fit in {ref}.")
        target = Zone(r.zone.top, r.zone.left, r.zone.top + height - 1, r.zone.left + width - 1)
        if target.bottom >= DEFAULT_LIMITS["rows"] or target.right >= DEFAULT_LIMITS["cols"]:
            raise SpillError("#SPILL!: the values would reach past the sheet.")
        mine = self._writes.get(self.origin, {})
        held = self.store.values(r.sheet, target)
        for i, row in enumerate(held):
            for j, v in enumerate(row):
                at = (r.sheet, target.top + i, target.left + j)
                if v is not None and at not in mine:
                    raise SpillError(
                        f"#SPILL!: {column_letters(target.left + j)}{target.top + i + 1} is not empty."
                    )
        cells: dict[tuple[int, int], Value] = {}
        for i in range(height):
            for j in range(width):
                v = rows[i][j] if j < len(rows[i]) else None
                cells[(target.top + i, target.left + j)] = v
        self._write(r.sheet, cells)

    def _write(self, sheet: str, cells: dict[tuple[int, int], Value]) -> None:
        before = self.store.values(
            sheet,
            Zone(min(r for r, _ in cells), min(c for _, c in cells), max(r for r, _ in cells), max(c for _, c in cells)),
        )
        mine = self._writes.setdefault(self.origin, {})
        top = min(r for r, _ in cells)
        left = min(c for _, c in cells)
        for (r, c), _v in cells.items():
            key = (sheet, r, c)
            if key not in mine:
                mine[key] = before[r - top][c - left]
        self.store.write(sheet, cells, self.origin)

    def undo_writes(self, origin: str | None = None) -> int:
        """Put back what a cell's runs wrote (*Undo the cell's writes*); the number of cells restored."""
        key = origin or self.origin
        mine = self._writes.pop(key, {})
        by_sheet: dict[str, dict[tuple[int, int], Value]] = {}
        for (sheet, r, c), v in mine.items():
            by_sheet.setdefault(sheet, {})[(r, c)] = v
        for sheet, cells in by_sheet.items():
            self.store.write(sheet, cells, f"{key} (undone)")
        return len(mine)

    # -- following the page

    def on_change(self, ref: str, callback: Callable[[Any], None]) -> Callable[[], None]:
        """Call ``callback(values)`` when the range's values change; returns the function that stops it."""
        r = self._resolve(ref)
        last = [self.store.values(r.sheet, r.zone)]

        def check() -> None:
            now = self.store.values(r.sheet, r.zone)
            if now != last[0]:
                last[0] = now
                callback(_frame(now, None) if not (r.zone.rows == 1 and r.zone.cols == 1) else now[0][0])

        return self.store.subscribe(check)


def _zone_ref(z: Zone) -> str:
    a = f"{column_letters(z.left)}{z.top + 1}"
    if z.rows == 1 and z.cols == 1:
        return a
    return f"{a}:{column_letters(z.right)}{z.bottom + 1}"


def _frame(rows: list[list[Value]], header: bool | None) -> Any:
    try:
        import pandas as pd
    except ImportError:
        return rows
    if not rows:
        return pd.DataFrame()
    head = rows[0]
    if header is None:
        header = (
            len(rows) > 1
            and all(isinstance(h, str) for h in head)
            and any(not isinstance(v, str) for r in rows[1:] for v in r if v is not None)
        )
    if header:
        return pd.DataFrame([list(r) for r in rows[1:]], columns=[str(h) for h in head])
    return pd.DataFrame([list(r) for r in rows])


def _cell_value(v: Any) -> Value:
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else None
    if hasattr(v, "item"):
        try:
            return _cell_value(v.item())
        except (ValueError, TypeError):
            pass
    return str(v)


def _rows_of(value: Any) -> list[list[Value]]:
    """A value, a list, a list of rows or a DataFrame as rows (a DataFrame's columns first)."""
    if hasattr(value, "columns") and hasattr(value, "values"):
        head: list[Value] = [str(c) for c in value.columns]
        return [head] + [[_cell_value(v) for v in row] for row in value.values.tolist()]
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        rows = [list(r) if isinstance(r, (list, tuple)) else [r] for r in value]
        return [[_cell_value(v) for v in r] for r in rows]
    return [[_cell_value(value)]]


__all__ = [
    "AxisOrder",
    "DEFAULT_LIMITS",
    "JsonStore",
    "LiveWorkbook",
    "LoroStore",
    "SheetView",
    "SpillError",
    "Store",
    "Zone",
    "implicit_id",
    "implicit_index",
    "implicit_key",
]
