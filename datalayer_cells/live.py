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

    def charts(self, sheet: str) -> dict[str, dict[str, Any]]:
        """The charts of a sheet as specs at the current positions (§3.12), by id."""
        raise NotImplementedError

    def write_chart(self, sheet: str, before: dict[str, Any] | None, after: dict[str, Any], origin: str) -> None:
        """Insert (``before`` is ``None``) or change a chart."""
        raise NotImplementedError

    def delete_chart(self, sheet: str, chart_id: str, origin: str) -> None:
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
        # An id listed twice (two peers putting one sheet back concurrently) is one sheet, as in the binding.
        ids = list(dict.fromkeys(x for x in self.doc.get_movable_list("sheets").get_value() if isinstance(x, str)))
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

    # -- charts: the ``charts:<sheetId>`` root of the binding (``src/collab/binding.ts``)

    def _sheet_by_name(self, name: str) -> str | None:
        lower = name.lower()
        for s in self.sheet_ids():
            if self.sheet_name(s).lower() == lower:
                return s
        return None

    def _ref_to_ids(self, ref: str, sheet: str) -> str:
        """A range (``Sheet1!$B$2:$B$5``) in id form (``Sheet1!⟦$b1|$b1⟧:⟦$b1|$b4⟧``), as the binding's ``#toIdForm``."""
        from .charts import ref_zone

        if ref_zone(ref) is None:  # ``#REF!``: a range already gone stays as it is
            return ref
        name, a1 = split_sheet(ref)
        target = (self._sheet_by_name(name) or sheet) if name is not None else sheet
        rows = self._order(target, "rows")
        cols = self._order(target, "cols")
        out = []
        for part in a1.split(":"):
            m = _A1.fullmatch(part.strip())
            if m is None:
                raise ValueError(f"'{ref}' is not a range such as Sheet1!A1:C4.")
            out.append(f"⟦{m[1]}{cols.id_at(column_index(m[2]))}|{m[3]}{rows.id_at(int(m[4]) - 1)}⟧")
        return ref[: len(ref) - len(a1)] + ":".join(out)

    def _ref_from_ids(self, text: str, sheet: str) -> str:
        """A range in id form as A1 text at the current positions; one with an end gone is ``#REF!`` whole."""
        out = ""
        last = 0
        previous = sheet
        for m in _ID_FORM.finditer(text):
            before = text[last : m.start()]
            out += before
            prefix = _PREFIX.search(out)
            named = None if prefix is None else (prefix[1].replace("''", "'") if prefix[1] else prefix[2])
            if named is not None:
                target = self._sheet_by_name(named) or sheet
            elif before == ":":
                target = previous
            else:
                target = sheet
            previous = target
            col_abs, col_id, row_abs, row_id = m.groups()
            col = None if col_id == "" else self._order(target, "cols").position_of(col_id)
            row = None if row_id == "" else self._order(target, "rows").position_of(row_id)
            if (col_id != "" and col is None) or (row_id != "" and row is None):
                if prefix is not None:
                    out = out[: len(out) - len(prefix[0])]
                out += "#REF!"
            else:
                out += ("" if col is None else f"{col_abs}{column_letters(col)}") + (
                    "" if row is None else f"{row_abs}{row + 1}"
                )
            last = m.end()
        out += text[last:]
        out = _GONE.sub("#REF!", out)
        return "#REF!" if "#REF!" in out else out

    def _series_to_ids(self, s: dict[str, Any], sheet: str) -> dict[str, Any]:
        from .charts import ref_zone

        out: dict[str, Any] = {"values": self._ref_to_ids(s["values"], sheet)}
        if "name" in s:
            out["name"] = self._ref_to_ids(s["name"], sheet) if ref_zone(s["name"]) is not None else s["name"]
        for k in ("categories", "x"):
            if k in s:
                out[k] = self._ref_to_ids(s[k], sheet)
        for k in ("type", "axis", "color"):
            if k in s:
                out[k] = s[k]
        return out

    def _anchor_to_ids(self, a: dict[str, Any], sheet: str) -> dict[str, Any]:
        if a["kind"] == "absolute":
            return dict(a)
        rows = self._order(sheet, "rows")
        cols = self._order(sheet, "cols")

        def corner(c: dict[str, Any]) -> dict[str, Any]:
            return {"r": rows.id_at(c["row"]), "c": cols.id_at(c["col"]), "dx": c["dx"], "dy": c["dy"]}

        if a["kind"] == "cell":
            return {"kind": "cell", "from": corner(a["from"]), "width": a["width"], "height": a["height"]}
        return {"kind": "cells", "from": corner(a["from"]), "to": corner(a["to"])}

    def charts(self, sheet: str) -> dict[str, dict[str, Any]]:
        """The charts of a sheet as the binding's ``#readCharts`` projects them: a deleted id is ``#REF!``, an anchor whose corner is gone collapses onto its other corner, one with both gone is dropped."""
        rows = self._order(sheet, "rows")
        cols = self._order(sheet, "cols")

        def corner(c: Any) -> dict[str, Any] | None:
            if not isinstance(c, dict) or not isinstance(c.get("r"), str) or not isinstance(c.get("c"), str):
                return None
            row = rows.position_of(c.get("r"))
            col = cols.position_of(c.get("c"))
            if row is None or col is None or row >= self.limits["rows"] or col >= self.limits["cols"]:
                return None
            return {"row": row, "col": col, "dx": c.get("dx"), "dy": c.get("dy")}

        out: dict[str, dict[str, Any]] = {}
        for chart_id, raw in self.doc.get_map(f"charts:{sheet}").get_deep_value().items():
            if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
                continue
            a = raw.get("anchor") or {}
            anchor: dict[str, Any] | None = None
            if a.get("kind") == "absolute":
                anchor = {k: a.get(k) for k in ("kind", "x", "y", "width", "height")}
            elif a.get("kind") == "cell":
                f = corner(a.get("from"))
                if f is not None:
                    anchor = {"kind": "cell", "from": f, "width": a.get("width"), "height": a.get("height")}
            elif a.get("kind") == "cells":
                f = corner(a.get("from"))
                t = corner(a.get("to"))
                if f is not None and t is not None:
                    anchor = {
                        "kind": "cells",
                        "from": {"row": min(f["row"], t["row"]), "col": min(f["col"], t["col"]), "dx": f["dx"], "dy": f["dy"]},
                        "to": {"row": max(f["row"], t["row"]), "col": max(f["col"], t["col"]), "dx": t["dx"], "dy": t["dy"]},
                    }
                elif f is not None:
                    anchor = {"kind": "cells", "from": f, "to": f}
                elif t is not None:
                    anchor = {"kind": "cells", "from": t, "to": t}
            if anchor is None:
                continue
            series = []
            for x in raw.get("series") if isinstance(raw.get("series"), list) else []:
                if not isinstance(x, dict) or not isinstance(x.get("values"), str):
                    continue
                sr: dict[str, Any] = {}
                if isinstance(x.get("name"), str):
                    sr["name"] = self._ref_from_ids(x["name"], sheet) if "⟦" in x["name"] else x["name"]
                sr["values"] = self._ref_from_ids(x["values"], sheet)
                for k in ("categories", "x"):
                    if isinstance(x.get(k), str):
                        sr[k] = self._ref_from_ids(x[k], sheet)
                for k in ("type", "axis", "color"):
                    if x.get(k) is not None:
                        sr[k] = x[k]
                series.append(sr)
            if not series:
                continue
            spec: dict[str, Any] = {
                "id": chart_id,
                "type": raw["type"],
                "anchor": anchor,
                "data": {
                    "series": series,
                    "by": raw.get("by", "columns"),
                    "headers": raw.get("headers", {"row": False, "column": False}),
                    "blanks": raw.get("blanks", "gap"),
                },
                "legend": raw.get("legend", "bottom"),
            }
            for k in ("variant", "title", "axes", "labels"):
                if raw.get(k) is not None:
                    spec[k] = raw[k]
            out[chart_id] = spec
        return out

    def write_chart(self, sheet: str, before: dict[str, Any] | None, after: dict[str, Any], origin: str) -> None:
        """A chart's fields into its map, field by field (two peers changing different fields both keep theirs), as the binding's ``#writeChart``."""
        charts = self.doc.get_map(f"charts:{sheet}")
        if before is None:
            m = charts.insert_container(after["id"], _loro.LoroMap())
        else:
            m = charts.get_or_create_container(after["id"], _loro.LoroMap())
        for f in ("type", "variant", "title", "legend", "axes", "labels"):
            if before is not None and before.get(f) == after.get(f):
                continue
            if after.get(f) is None:
                m.delete(f)
            else:
                m.insert(f, after[f])
        for f in ("by", "headers", "blanks"):
            if before is not None and before["data"].get(f) == after["data"].get(f):
                continue
            m.insert(f, after["data"][f])
        if before is None or before["anchor"] != after["anchor"]:
            m.insert("anchor", self._anchor_to_ids(after["anchor"], sheet))
        want = lambda: [self._series_to_ids(x, sheet) for x in after["data"]["series"]]  # noqa: E731
        if before is None:
            series = m.insert_container("series", _loro.LoroMovableList())
            for i, x in enumerate(want()):
                series.insert(i, x)
        elif before["data"]["series"] != after["data"]["series"]:
            series = m.get_or_create_container("series", _loro.LoroMovableList())
            have = series.get_deep_value()
            want = want()
            n = min(len(have), len(want))
            for i in range(n):
                if have[i] != want[i]:
                    series.set(i, want[i])
            for i in range(n, len(want)):
                series.insert(i, want[i])
            if len(have) > len(want):
                series.delete(len(want), len(have) - len(want))
        self.doc.set_next_commit_message(origin)
        self.doc.commit()

    def delete_chart(self, sheet: str, chart_id: str, origin: str) -> None:
        self.doc.get_map(f"charts:{sheet}").delete(chart_id)
        self.doc.set_next_commit_message(origin)
        self.doc.commit()

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


_A1 = re.compile(r"(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})")
#: A reference in id form: ``⟦$col|$row⟧``, either part empty for whole rows or columns.
_ID_FORM = re.compile(r"⟦(\$?)([^|⟧]*)\|(\$?)([^⟧]*)⟧")
_PREFIX = re.compile(r"(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!$")
_GONE = re.compile(r"#REF!:[$A-Za-z0-9]+|[$A-Za-z0-9]+:#REF!|#REF!:#REF!")


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

    def charts(self, sheet: str) -> dict[str, dict[str, Any]]:
        return {k: dict(v) for k, v in self._sheet(sheet).get("charts", {}).items()}

    def write_chart(self, sheet: str, before: dict[str, Any] | None, after: dict[str, Any], origin: str) -> None:
        raise NotImplementedError("Charts are written into the collaboration document, which needs loro-py; this kernel has none.")

    def delete_chart(self, sheet: str, chart_id: str, origin: str) -> None:
        raise NotImplementedError("Charts are written into the collaboration document, which needs loro-py; this kernel has none.")


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
    and answered to the grid, which makes them the cell's precedents; the ranges
    it wrote (``end_writes``) are answered too, so the cell's own writes never
    make it run again. ``origin``
    names the code cell whose writes these are (``Sheet1!C4``), the attribution
    of the collaboration patches.
    """

    store: Store
    origin: str = "python"
    _reads: list[str] | None = None
    _run_writes: list[str] | None = None
    _writes: dict[str, dict[tuple[str, int, int], Value]] = field(default_factory=dict)
    _watchers: list[tuple[_Range, Callable[[Any], None], list]] = field(default_factory=list)

    # -- runs

    def begin_run(self, origin: str | None = None) -> None:
        """Start recording the ranges this run reads; ``origin`` names the cell that runs."""
        self._reads = []
        self._run_writes = []
        if origin is not None:
            self.origin = origin

    def end_run(self) -> list[str]:
        """The ranges the run read, as references (``Sheet1!A1:B7``), in order, each once."""
        reads = self._reads or []
        self._reads = None
        return reads

    def end_writes(self) -> list[str]:
        """The ranges the run wrote, as references (``Sheet1!E1:F3``), in order, each once."""
        writes = self._run_writes or []
        self._run_writes = None
        return writes

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
        if self._run_writes is not None:
            zone = Zone(top, left, max(r for r, _ in cells), max(c for _, c in cells))
            q = self._qualified(_Range(sheet, zone))
            if q not in self._run_writes:
                self._run_writes.append(q)
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

    # -- charts (§3.12, C10-09): the same API as ``Workbook``'s, written into the document

    def _sheet_id(self, sheet: str | None) -> str:
        return self.sheet(sheet).sheet

    def charts(self, sheet: str | None = None) -> list[dict[str, Any]]:
        """The charts of a sheet (the first by default), as their specs at the current positions."""
        return list(self.store.charts(self._sheet_id(sheet)).values())

    def _check_chart(self, sheet: str, spec: dict[str, Any]) -> None:
        from .charts import MAX_CHART_POINTS, ChartRefusal, chart_problem, ref_zone

        limits = getattr(self.store, "limits", DEFAULT_LIMITS)
        problem = chart_problem(spec, limits)
        if problem is not None:
            raise ChartRefusal("InvalidArgument", problem)
        points = 0
        numeric = False
        for s in spec["data"]["series"]:
            found = ref_zone(s["values"])
            if found is None:
                continue
            name, (top, left, bottom, right) = found
            target = self._sheet_id(name) if name is not None else sheet
            points += (bottom - top + 1) * (right - left + 1)
            if not numeric:
                numeric = any(
                    isinstance(v, (int, float)) and not isinstance(v, bool)
                    for row in self.store.values(target, Zone(top, left, bottom, right))
                    for v in row
                )
        if points > MAX_CHART_POINTS:
            raise ChartRefusal("ChartTooLarge", f"A chart holds at most {MAX_CHART_POINTS:,} points; this one has {points:,}.")
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
        """Add a chart of ``type`` from the cells of ``data`` (``Sheet1!A1:C13``, inferred as the TypeScript
        core infers a selection), anchored on the cells of ``anchor`` (``E2:L18``); every peer sees it.
        Returns its spec; refusals are :class:`~datalayer_cells.charts.ChartRefusal` with the core's reasons."""
        from .charts import ChartRefusal, infer_chart_data

        target = self._sheet_id(sheet)
        source = self._resolve(data)
        z = source.zone
        held = self.store.values(source.sheet, z)
        inferred = infer_chart_data(
            lambda r, c: held[r - z.top][c - z.left],
            self.store.sheet_name(source.sheet),
            (z.top, z.left, z.bottom, z.right),
        )
        top, left, bottom, right = parse_zone(split_sheet(anchor)[1])
        existing = self.store.charts(target)
        if id is None:
            n = 1
            while f"chart{n}" in existing:
                n += 1
            id = f"chart{n}"
        elif id in existing:
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
        self._check_chart(target, spec)
        self.store.write_chart(target, None, spec, self.origin)
        return dict(spec)

    def update_chart(self, id: str, sheet: str | None = None, **changes: Any) -> dict[str, Any]:
        """Change a chart's type, variant, data, title, legend, axes or labels (``None`` removes a field); returns the new spec."""
        from .charts import ChartRefusal

        target = self._sheet_id(sheet)
        before = self.store.charts(target).get(id)
        if before is None:
            raise ChartRefusal("UnknownChart", f"No chart '{id}' on this sheet.")
        if "id" in changes or "anchor" in changes:
            raise ChartRefusal("InvalidArgument", "An update changes neither the id nor the anchor (MOVE_CHART, RESIZE_CHART).")
        after = {**before, **{k: v for k, v in changes.items() if v is not None}}
        for k, v in changes.items():
            if v is None:
                after.pop(k, None)
        self._check_chart(target, after)
        self.store.write_chart(target, before, after, self.origin)
        return dict(after)

    def remove_chart(self, id: str, sheet: str | None = None) -> None:
        from .charts import ChartRefusal

        target = self._sheet_id(sheet)
        if id not in self.store.charts(target):
            raise ChartRefusal("UnknownChart", f"No chart '{id}' on this sheet.")
        self.store.delete_chart(target, id, self.origin)

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
