#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Write ``tests/collab/live-python.loro``: the TypeScript binding's ``live.loro`` after ``datalayer_cells`` wrote into it.

    python dev/live_fixture.py

``src/collab/__tests__/liveFixture.test.ts`` reads it back through the
TypeScript binding, which is what proves the two sides share one schema.
"""

from __future__ import annotations

import sys
from pathlib import Path

import loro

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from datalayer_cells.live import LiveWorkbook, LoroStore  # noqa: E402
DIR = ROOT / "tests" / "collab"


def main() -> None:
    doc = loro.LoroDoc()
    doc.peer_id = 11
    doc.import_((DIR / "live.loro").read_bytes())
    cells = LiveWorkbook(LoroStore(doc), origin="Sheet1!C3")
    cells["C3"] = 42
    units = cells.values("B3:B5")
    cells["E3:E5"] = [[v[0] * 2] for v in units]
    cells["Figures!A2"] = "from python"
    (DIR / "live-python.loro").write_bytes(doc.export(loro.ExportMode.Snapshot()))
    print(f"wrote {DIR / 'live-python.loro'}")


if __name__ == "__main__":
    main()
