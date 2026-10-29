# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The live workbook (C11-09): ``datalayer_cells`` over the collaboration document.

``tests/collab/live.loro`` is a document the TypeScript binding wrote (a table,
a formula, a second sheet, a row inserted and a column deleted): what Python
reads at each position must be what the page shows there, which
``src/collab/__tests__/liveFixture.test.ts`` pins. The comm transport is
tested with a fake comm; the room transport against the rooms server of
``scripts/collab-server.mjs`` when ``node``, ``tsx`` and the package's
``node_modules`` are at hand (the Python CI job has none: that test skips there).
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

loro = pytest.importorskip("loro")

from datalayer_cells import cells as proxy  # noqa: E402
from datalayer_cells.live import AxisOrder, JsonStore, LiveWorkbook, LoroStore, SpillError, implicit_id  # noqa: E402
from datalayer_cells.transport import CommTransport, FakeComm, RoomClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "collab" / "live.loro"


def fixture_doc(peer: int = 21):
    doc = loro.LoroDoc()
    doc.peer_id = peer
    doc.import_(FIXTURE.read_bytes())
    return doc


def workbook(peer: int = 21, origin: str = "Sheet1!C3") -> LiveWorkbook:
    return LiveWorkbook(LoroStore(fixture_doc(peer)), origin=origin)


class TestAxisOrder:
    def test_an_untouched_axis_is_the_implicit_run(self):
        order = AxisOrder({}, 100)
        assert [order.id_at(i) for i in range(3)] == ["b0", "b1", "b2"]
        assert order.position_of(implicit_id(41)) == 41

    def test_an_explicit_id_sits_among_the_implicit_ones_by_its_key(self):
        # One row inserted before position 1: its key sorts between b0's and b1's.
        order = AxisOrder({"r7": {"key": "100000V"}}, 100)
        assert [order.id_at(i) for i in range(4)] == ["b0", "r7", "b1", "b2"]
        assert order.position_of("r7") == 1
        assert order.position_of("b1") == 2

    def test_a_deleted_implicit_id_leaves_the_run(self):
        order = AxisOrder({"b2": {"deleted": True}}, 100)
        assert [order.id_at(i) for i in range(4)] == ["b0", "b1", "b3", "b4"]
        assert order.position_of("b2") is None
        assert order.position_of("b3") == 2


class TestReading:
    def test_reads_what_the_page_shows_at_each_position(self):
        w = workbook()
        assert w.store.sheet_ids() == ["s1", "s2"]
        assert w.sheet().name == "Sheet1"
        assert w.sheet("Figures").name == "Figures"
        # The TypeScript fixture: row 2 inserted blank, the third column deleted; a formula's cached value is not in the document.
        assert w.values("A1:C5") == [
            ["Month", "Units", None],
            [None, None, None],
            ["Jan", 12, None],
            ["Feb", 15, None],
            ["Mar", 19, None],
        ]
        assert w["B3"] == 12
        assert w["Figures!A1"] == "fig"
        assert w.values("Figures!A1:B1") == [["fig", 1]]

    def test_a_range_is_a_frame_where_pandas_is(self):
        pd = pytest.importorskip("pandas")
        w = workbook()
        frame = w["A3:B5"]
        assert isinstance(frame, pd.DataFrame)
        assert frame.values.tolist() == [["Jan", 12], ["Feb", 15], ["Mar", 19]]
        with_header = w.sheet("Figures").frame(header=True)
        assert list(with_header.columns) == ["fig", "1"]

    def test_the_ranges_a_run_read_are_answered_qualified_and_once(self):
        w = workbook()
        w.begin_run("Sheet1!C3")
        w["B3"]
        w.values("A1:B5")
        w["B3"]
        w["Figures!A1:B1"]
        assert w.end_run() == ["Sheet1!B3", "Sheet1!A1:B5", "Figures!A1:B1"]
        assert w.end_run() == []

    def test_the_ranges_a_run_wrote_are_answered_qualified_and_once(self):
        w = workbook()
        w["F1"] = 1  # outside a run: not recorded
        w.begin_run("Sheet1!C3")
        w["E2"] = 42
        w["E2"] = 43
        w["G1:H2"] = [[1, 2], [3, 4]]
        w.end_run()
        assert w.end_writes() == ["Sheet1!E2", "Sheet1!G1:H2"]
        assert w.end_writes() == []


class TestWriting:
    def test_a_value_written_is_a_patch_a_peer_reads(self):
        w = workbook(21)
        before = w.store.doc.oplog_vv
        w["C3"] = 42
        assert w["C3"] == 42
        update = w.store.doc.export(loro.ExportMode.Updates(from_=before))
        peer = workbook(22)
        peer.store.apply(update)
        assert peer["C3"] == 42
        # Stored where the TypeScript binding looks: the cell's row and column ids, the value under v.
        stored = peer.store.doc.get_map("cells:s1").get_value()
        assert any(v == {"v": 42} for v in stored.values())

    def test_a_frame_spills_and_is_refused_over_a_value(self):
        w = workbook()
        w["E3:E5"] = [[24], [30], [38]]
        assert w.values("E3:E5") == [[24], [30], [38]]
        w["G1"] = [["a", "b"], [1, 2]]
        assert w.values("G1:H2") == [["a", "b"], [1, 2]]
        with pytest.raises(SpillError, match="#SPILL!: A3 is not empty"):
            w["A3"] = [[1, 2], [3, 4]]
        with pytest.raises(SpillError, match="do not fit"):
            w["E1:E2"] = [[1], [2], [3]]

    def test_a_cell_may_spill_over_its_own_last_writes(self):
        w = workbook(21, origin="Sheet1!C3")
        w["E3"] = [[1], [2]]
        w["E3"] = [[3], [4], [5]]
        assert w.values("E3:E5") == [[3], [4], [5]]
        # Another cell's spill over them is refused (a single value written to one cell is a plain write, not a spill).
        other = LiveWorkbook(w.store, origin="Sheet1!D9")
        with pytest.raises(SpillError):
            other["E3"] = [[9], [10]]

    def test_undo_the_cells_writes(self):
        w = workbook(21, origin="Sheet1!C3")
        w["B3"] = 100
        w["E3:E4"] = [[1], [2]]
        assert w.undo_writes() == 3
        assert w["B3"] == 12
        assert w.values("E3:E4") == [[None], [None]]

    def test_on_change_follows_a_peer(self):
        a = workbook(21)
        b = workbook(22)
        seen = []
        a.on_change("B3:B5", lambda frame: seen.append(frame))
        before = b.store.doc.oplog_vv
        b["B4"] = 99
        a.store.apply(b.store.doc.export(loro.ExportMode.Updates(from_=before)))
        assert len(seen) == 1
        rows = seen[0].values.tolist() if hasattr(seen[0], "values") else seen[0]
        assert rows == [[12], [99], [19]]


class TestCharts:
    """C10-09: charts in the ``charts:<sheetId>`` root, in the binding's schema (ranges in id form, anchors on ids)."""

    def test_a_chart_added_is_stored_on_ids_and_a_peer_reads_its_spec(self):
        w = workbook(21)
        before = w.store.doc.oplog_vv
        spec = w.add_chart("line", "A3:B5", "G2:J8", title="Units", variant="smooth")
        assert spec["data"]["series"] == [{"values": "Sheet1!$B$3:$B$5", "categories": "Sheet1!$A$3:$A$5"}]
        stored = w.store.doc.get_map("charts:s1").get_deep_value()["chart1"]
        # The fixture's row 2 was inserted on the page (p7-1) and its third column deleted: ids, not positions.
        assert stored["series"] == [{"values": "Sheet1!⟦$b1|$b1⟧:⟦$b1|$b3⟧", "categories": "Sheet1!⟦$b0|$b1⟧:⟦$b0|$b3⟧"}]
        assert stored["anchor"]["from"] == {"r": "p7-1", "c": "b7", "dx": 0, "dy": 0}
        peer = workbook(22)
        peer.store.apply(w.store.doc.export(loro.ExportMode.Updates(from_=before)))
        assert peer.charts() == [spec]

    def test_a_range_of_another_sheet_keeps_its_prefix(self):
        w = workbook()
        spec = w.add_chart("column", "Figures!A1:B1", "E2:H9", sheet="Sheet1")
        assert spec["data"]["series"][0]["values"] == "Figures!$B$1"
        assert w.charts()[0]["data"]["series"][0]["values"] == "Figures!$B$1"
        assert w.charts("Figures") == []

    def test_update_and_remove(self):
        w = workbook()
        w.add_chart("column", "A3:B5", "G2:J8", title="Units")
        after = w.update_chart("chart1", type="bar", title=None, legend="top")
        assert "title" not in after
        assert w.charts() == [after]
        assert w.charts()[0]["type"] == "bar" and w.charts()[0]["legend"] == "top"
        w.remove_chart("chart1")
        assert w.charts() == []

    def test_the_refusals_are_the_cores(self):
        from datalayer_cells.charts import ChartRefusal

        w = workbook()
        with pytest.raises(ChartRefusal) as e:
            w.add_chart("column", "A1:A1", "E2:H9")
        assert e.value.reason == "NoNumericData"
        w.add_chart("column", "A3:B5", "G2:J8", id="units")
        with pytest.raises(ChartRefusal) as e:
            w.add_chart("column", "A3:B5", "G2:J8", id="units")
        assert e.value.reason == "DuplicateChart"
        with pytest.raises(ChartRefusal) as e:
            w.update_chart("units", legend="middle")
        assert e.value.reason == "InvalidArgument" and "legend" in str(e.value)
        with pytest.raises(ChartRefusal) as e:
            w.update_chart("units", anchor={})
        assert e.value.reason == "InvalidArgument"
        for call in (lambda: w.update_chart("gone", title="x"), lambda: w.remove_chart("gone")):
            with pytest.raises(ChartRefusal) as e:
                call()
            assert e.value.reason == "UnknownChart"

    def test_a_kernel_without_loro_reads_charts_and_refuses_to_write_them(self):
        workbook_json = json.loads((ROOT / "tests" / "collab" / "live.json").read_text())
        w = LiveWorkbook(JsonStore(workbook_json))
        assert w.charts() == []
        with pytest.raises(NotImplementedError, match="loro-py"):
            w.add_chart("column", "A3:B5", "G2:J8")


class TestCommTransport:
    def test_over_loro_bytes_the_page_sends_the_snapshot_and_reads_the_kernels_writes(self):
        comm = FakeComm()
        transport = CommTransport(comm, {"mode": "loro"})
        assert comm.sent[0] == {"type": "ready", "mode": "loro"}
        comm.deliver({"type": "snapshot", "data": base64.b64encode(FIXTURE.read_bytes()).decode()})
        cells = transport.workbook
        assert cells["B3"] == 12
        cells.begin_run("Sheet1!C3")
        cells["C3"] = 42
        update = [m for m in comm.sent if m["type"] == "update"][-1]
        page = fixture_doc(5)
        page.import_(base64.b64decode(update["data"]))
        assert LiveWorkbook(LoroStore(page))["C3"] == 42
        # The page's later update reaches the kernel.
        page_cells = LiveWorkbook(LoroStore(page), origin="page")
        before = page.oplog_vv
        page_cells["B3"] = 13
        comm.deliver({"type": "update", "data": base64.b64encode(page.export(loro.ExportMode.Updates(from_=before))).decode()})
        assert cells["B3"] == 13

    def test_without_loro_the_page_sends_json_and_takes_the_writes(self):
        comm = FakeComm()
        transport = CommTransport(comm, {"mode": "json"})
        assert comm.sent[0] == {"type": "ready", "mode": "json"}
        workbook_json = json.loads((ROOT / "tests" / "collab" / "live.json").read_text())
        comm.deliver({"type": "snapshot", "workbook": workbook_json})
        cells = transport.workbook
        assert isinstance(cells.store, JsonStore)
        assert cells["B3"] == 12
        cells["C3"] = 42
        assert comm.sent[-1] == {"type": "write", "sheet": "s1", "origin": "python", "cells": [[2, 2, 42]]}
        assert cells["C3"] == 42


def _rooms_server():
    # lexical-loro's server entry imports its siblings without extensions: tsx resolves them, plain node does not.
    candidates = [ROOT / "node_modules" / ".bin" / "tsx"] + [parent / "node_modules" / ".bin" / "tsx" for parent in ROOT.parents[:4]]
    tsx = next((p for p in candidates if p.exists()), None)
    script = ROOT / "scripts" / "collab-server.mjs"
    if tsx is None or shutil.which("node") is None:
        pytest.skip("the rooms server needs node, tsx and the package's node_modules")
    process = subprocess.Popen(
        [str(tsx), str(script)],
        cwd=ROOT,
        env={**os.environ, "PORT": "0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    url = None
    for line in process.stdout:  # type: ignore[union-attr]
        if "Datalayer Cells rooms:" in line:
            url = line.split("rooms:")[1].strip().replace("/<room>", "")
            break
    if url is None:
        process.kill()
        pytest.skip("the rooms server did not start")
    threading.Thread(target=lambda: [None for _ in process.stdout], daemon=True).start()  # type: ignore[union-attr]
    return process, url


class TestRoomTransport:
    def test_two_peers_in_a_room_see_each_others_writes(self):
        process, url = _rooms_server()
        try:
            room = f"live-{os.getpid()}"
            a = RoomClient(url, room, store=LoroStore(fixture_doc(31)))
            a.wait(10)
            wa = LiveWorkbook(a.store, origin="Sheet1!C3")
            b = RoomClient(url, room)
            b.wait(10)
            wb = LiveWorkbook(b.store, origin="Sheet1!D3")
            # The late peer adopted the room, which the first peer seeded with the fixture.
            deadline = threading.Event()
            for _ in range(50):
                if wb.values("A1:B1") == [["Month", "Units"]]:
                    break
                deadline.wait(0.1)
            assert wb.values("A1:B1") == [["Month", "Units"]]
            wa["C3"] = 42
            for _ in range(50):
                if wb["C3"] == 42:
                    break
                deadline.wait(0.1)
            assert wb["C3"] == 42
            wb["C4"] = "back"
            for _ in range(50):
                if wa["C4"] == "back":
                    break
                deadline.wait(0.1)
            assert wa["C4"] == "back"
            a.close()
            b.close()
        finally:
            process.kill()


def test_the_proxy_binds_by_hand_and_says_so_otherwise():
    proxy._workbook = None
    with pytest.raises(RuntimeError, match="No workbook is bound"):
        proxy["A1"]
    w = workbook()
    proxy.bind(w)
    assert proxy["B3"] == 12
    proxy["C3"] = 7
    assert w["C3"] == 7
    proxy._workbook = None
