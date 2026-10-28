#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""A Python peer for the monkey party (C6-05, C8-05): ``datalayer_cells`` on a Loro document, driven over stdin.

    python dev/monkey_peer.py '{"rows": 30, "cols": 8}' <seed>

``src/collab/__tests__/monkeyPython.test.ts`` starts it beside TypeScript peers
and sends one JSON line per request; each gets one JSON line back:

- ``{"op": "import", "data": <b64>}``: merge a peer's snapshot or update.
- ``{"op": "vv"}``: this document's version vector, encoded (``{"vv": <b64>}``).
- ``{"op": "export", "vv": <b64>}``: the updates a peer at that version lacks.
- ``{"op": "act"}``: one random command through the package's API (values,
  spills, clears, *Undo the cell's writes*, charts added, changed and removed);
  ``{"applied": true}`` or ``{"applied": false, "refused": <reason>}``.
- ``{"op": "show"}``: every sheet's values over the limits and its charts, as
  this peer reads them.
"""

from __future__ import annotations

import base64
import json
import random
import sys
from pathlib import Path

import loro

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from datalayer_cells.charts import ChartRefusal, zone_ref  # noqa: E402
from datalayer_cells.live import LiveWorkbook, LoroStore, SpillError, Zone  # noqa: E402

ORIGINS = ("Sheet1!J1", "Sheet1!J2")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def act(store: LoroStore, rng: random.Random, limits: dict[str, int]) -> dict:
    w = LiveWorkbook(store, origin=rng.choice(ORIGINS))
    sheet = rng.choice(store.sheet_ids())
    name = store.sheet_name(sheet)
    row = rng.randrange(limits["rows"] - 4)
    col = rng.randrange(limits["cols"] - 2)
    at = zone_ref(name, (row, col, row, col))
    roll = rng.randrange(10)
    try:
        if roll < 4:
            w[at] = rng.choice([rng.randrange(100), f"p{rng.randrange(10)}"])
        elif roll == 4:
            w[at] = [[rng.randrange(10), rng.randrange(10)], [rng.randrange(10), "s"]]
        elif roll == 5:
            w[at] = None
        elif roll == 6:
            w.undo_writes()
        else:
            charts = [c["id"] for c in w.charts(name)]
            what = 0 if not charts else roll - 6
            if what == 0 or what > 3:
                w.add_chart(
                    rng.choice(["column", "line", "pie"]),
                    zone_ref(name, (row, col, row + 2, col + 1)),
                    zone_ref(name, (row, col + 1, row + 3, col + 1)),
                    sheet=name,
                )
            elif what == 1:
                chart = rng.choice(charts)
                if rng.randrange(2) == 0:
                    w.update_chart(chart, sheet=name, title=f"P{rng.randrange(100)}")
                else:
                    w.update_chart(chart, sheet=name, type=rng.choice(["column", "line", "bar"]))
            else:
                w.remove_chart(rng.choice(charts), sheet=name)
    except SpillError:
        return {"applied": False, "refused": "Spill"}
    except ChartRefusal as e:
        return {"applied": False, "refused": e.reason}
    return {"applied": True}


def main() -> None:
    limits = json.loads(sys.argv[1])
    rng = random.Random(int(sys.argv[2]))
    doc = loro.LoroDoc()
    doc.peer_id = 99
    store = LoroStore(doc, limits)
    for line in sys.stdin:
        msg = json.loads(line)
        op = msg["op"]
        if op == "import":
            doc.import_(base64.b64decode(msg["data"]))
            out: dict = {}
        elif op == "vv":
            out = {"vv": b64(doc.oplog_vv.encode())}
        elif op == "export":
            vv = loro.VersionVector.decode(base64.b64decode(msg["vv"]))
            out = {"data": b64(doc.export(loro.ExportMode.Updates(from_=vv)))}
        elif op == "act":
            out = act(store, rng, limits)
        elif op == "show":
            zone = Zone(0, 0, limits["rows"] - 1, limits["cols"] - 1)
            out = {
                "sheets": [
                    {"id": s, "values": store.values(s, zone), "charts": store.charts(s)}
                    for s in store.sheet_ids()
                ]
            }
        else:
            out = {"error": f"unknown op {op}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
