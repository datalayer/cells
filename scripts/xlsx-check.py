#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Open XLSX files written by Cells in a headless LibreOffice, and say what it read.

A file LibreOffice would ask to repair does not load here: loading it with
"RepairPackage" off fails. Each file must load, and its first sheet's used
cells are printed with their values, for a reader to compare.

    CELLS_XLSX_OUT=/tmp/cells-xlsx npx vitest run src/xlsx/__tests__/roundtrip.test.ts
    /usr/bin/python3 scripts/xlsx-check.py /tmp/cells-xlsx/*.xlsx
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path

import uno  # type: ignore[import-not-found]
from com.sun.star.beans import PropertyValue  # type: ignore[import-not-found]

PIPE = "cells_xlsx_check"


def prop(name: str, value: object) -> PropertyValue:
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def main(paths: list[str]) -> int:
    if not paths:
        raise SystemExit(__doc__)
    profile = tempfile.mkdtemp(prefix="cells-lo-")
    office = subprocess.Popen(
        [
            "soffice",
            "--headless",
            "--invisible",
            "--norestore",
            "--nologo",
            f"-env:UserInstallation=file://{profile}",
            f"--accept=pipe,name={PIPE};urp;",
        ]
    )
    failures = 0
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        for _ in range(60):
            try:
                ctx = resolver.resolve(f"uno:pipe,name={PIPE};urp;StarOffice.ComponentContext")
                break
            except Exception:  # noqa: BLE001 - LibreOffice is still starting
                time.sleep(0.5)
        else:
            raise SystemExit("LibreOffice did not start.")
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        for path in paths:
            url = uno.systemPathToFileUrl(str(Path(path).resolve()))
            try:
                doc = desktop.loadComponentFromURL(
                    url, "_blank", 0, (prop("Hidden", True), prop("RepairPackage", False))
                )
            except Exception as error:  # noqa: BLE001 - LibreOffice refused the file
                print(f"FAIL {path}: {error}")
                failures += 1
                continue
            if doc is None:
                print(f"FAIL {path}: LibreOffice did not open it")
                failures += 1
                continue
            sheets = doc.Sheets
            names = [sheets.getByIndex(i).Name for i in range(sheets.Count)]
            first = sheets.getByIndex(0)
            cursor = first.createCursor()
            cursor.gotoEndOfUsedArea(False)
            end = cursor.RangeAddress
            cells = []
            for r in range(min(end.EndRow, 11) + 1):
                cells.append([first.getCellByPosition(c, r).String for c in range(min(end.EndColumn, 5) + 1)])
            print(f"OK   {path}: sheets {names}; {cells}")
            doc.close(True)
    finally:
        office.terminate()
        office.wait(timeout=30)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
