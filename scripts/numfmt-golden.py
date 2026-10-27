#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Ask LibreOffice what each number format shows, and write tests/format/numfmt/golden.json.

Runs a headless LibreOffice and drives it over UNO: a Calc document, one cell
per case, the format code applied through the document's number formats
(en-US), and the cell's displayed string read back. Needs the python that has
LibreOffice's `uno` module (the system python on Debian and Ubuntu):

    /usr/bin/python3 scripts/numfmt-golden.py
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
from pathlib import Path

import uno  # type: ignore[import-not-found]
from com.sun.star.beans import PropertyValue  # type: ignore[import-not-found]
from com.sun.star.lang import Locale  # type: ignore[import-not-found]

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "tests" / "format" / "numfmt" / "cases.json"
GOLDEN = ROOT / "tests" / "format" / "numfmt" / "golden.json"
PIPE = "cells_numfmt"


def prop(name: str, value: object) -> PropertyValue:
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def lo_code(code: str) -> str:
    """The code with its date and time letters upper-cased, outside quotes and brackets of colours:
    LibreOffice's en-US keywords (YYYY, MM, DD, HH, SS) mean what Excel's lower-case ones do."""
    out = []
    quoted = False
    bracket = False
    for ch in code:
        if ch == '"':
            quoted = not quoted
        elif ch == "[" and not quoted:
            bracket = True
        elif ch == "]" and not quoted:
            bracket = False
        if not quoted and ch in "ymdhs" and not bracket:
            out.append(ch.upper())
        elif not quoted and bracket and ch in "hms":
            out.append(ch.upper())
        else:
            out.append(ch)
    return "".join(out)


def main() -> None:
    cases = json.loads(CASES.read_text())["cases"]
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
        doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))
        sheet = doc.Sheets.getByIndex(0)
        formats = doc.NumberFormats
        locale = Locale("en", "US", "")
        golden = []
        for i, case in enumerate(cases):
            code = lo_code(case["format"])
            key = formats.queryKey(code, locale, True)
            if key == -1:
                try:
                    key = formats.addNew(code, locale)
                except Exception as error:  # noqa: BLE001 - LibreOffice refuses the code
                    raise SystemExit(f"LibreOffice refuses the format {case['format']!r}: {error}") from error
            cell = sheet.getCellByPosition(0, i)
            cell.NumberFormat = key
            cell.Value = float(case["value"])
            golden.append({"format": case["format"], "value": case["value"], "shows": cell.String})
        doc.close(True)
        GOLDEN.write_text(
            json.dumps({"note": "What LibreOffice shows for each case of cases.json, en-US.", "cases": golden}, indent=2, ensure_ascii=False)
            + "\n"
        )
        print(f"wrote {GOLDEN} ({len(golden)} cases)")
    finally:
        office.terminate()
        office.wait(timeout=30)


if __name__ == "__main__":
    main()
