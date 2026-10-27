#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Ask LibreOffice what each formula of tests/formula/cases.json computes, and write
tests/formula/golden.json.

Runs a headless LibreOffice and drives it over UNO: a Calc document with the
cases' data block on Sheet1 (columns A to F, rows 1 to 10) and the `other`
cells on a sheet named Other, each formula in column H of its own row (case i
in row i + 1), and the result read back with its type. Formulas are written in
Excel's syntax in the cases; they are converted to LibreOffice's API grammar
(`;` between arguments, `~` for the union, `!` for the intersection, `|`
between the rows of an array). Needs the python that has LibreOffice's `uno`
module (the system python on Debian and Ubuntu):

    /usr/bin/python3 scripts/formula-golden.py
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import time
from pathlib import Path

import uno  # type: ignore[import-not-found]
from com.sun.star.beans import PropertyValue  # type: ignore[import-not-found]

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "tests" / "formula" / "cases.json"
GOLDEN = ROOT / "tests" / "formula" / "golden.json"
PIPE = "cells_formula"
FORMULA_COLUMN = 7  # H
COLUMNS = "ABCDEF"

# com.sun.star.sheet.FormulaResult
VALUE, STRING, ERROR = 1, 2, 4


def prop(name: str, value: object) -> PropertyValue:
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def to_api(formula: str) -> str:
    """An Excel-syntax formula in LibreOffice's API grammar."""
    out: list[str] = []
    stack: list[str] = []  # 'call', 'group' or 'array'
    i = 0
    n = len(formula)
    while i < n:
        ch = formula[i]
        if ch == '"' or ch == "'":
            j = i + 1
            while j < n:
                if formula[j] == ch:
                    if j + 1 < n and formula[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            out.append(formula[i : j + 1])
            i = j + 1
            if ch == "'" and i < n and formula[i] == "!":
                out.append(".")  # a quoted sheet name: 'My sheet'.A1
                i += 1
            continue
        if ch == "(":
            prev = "".join(out).rstrip()
            stack.append("call" if re.search(r"[A-Za-z0-9_.]$", prev) else "group")
            out.append(ch)
        elif ch == ")":
            stack.pop()
            out.append(ch)
        elif ch == "{":
            stack.append("array")
            out.append(ch)
        elif ch == "}":
            stack.pop()
            out.append(ch)
        elif ch == "!" and re.search(r"(?<![#A-Za-z0-9_/])[A-Za-z_][A-Za-z0-9_]*$", "".join(out)):
            out.append(".")  # a sheet name: Other.A1
        elif ch == ",":
            top = stack[-1] if stack else "group"
            out.append(";" if top in ("call", "array") else "~")
        elif ch == ";" and stack and stack[-1] == "array":
            out.append("|")
        elif ch == " ":
            # Between two references, a space is the intersection operator.
            before = "".join(out).rstrip()
            after = formula[i:].lstrip()
            if re.search(r"[A-Za-z0-9$)]$", before) and re.match(r"[A-Za-z$('(]", after):
                out.append("!")
                i += len(formula[i:]) - len(after)
                continue
            out.append(ch)
        else:
            out.append(ch)
        i += 1
    text = "".join(out)
    # Functions of the Analysis add-in go by their programmatic names in the API grammar.
    for name in ANALYSIS:
        text = re.sub(rf"\b{name}\(", f"COM.SUN.STAR.SHEET.ADDIN.ANALYSIS.GET{name}(", text)
    return text


ANALYSIS = ["EDATE", "EOMONTH", "RANDBETWEEN"]

# Where LibreOffice 7.3 has no answer or answers otherwise than Excel, what Excel computes,
# written by hand: XLOOKUP and XMATCH arrived in LibreOffice 24.8; LibreOffice turns TRUE
# into 1 when joining text, Excel into "TRUE"; LibreOffice's TRUE in a cell is the number 1,
# which SUM, AVERAGE and COUNT of a range then read, where Excel skips a logical value.
EXCEL = {
    'XLOOKUP("fig",C1:C10,F1:F10)': {"number": 60.0},
    'XLOOKUP("zz",C1:C10,F1:F10,"none")': {"string": "none"},
    "XMATCH(70,F1:F10)": {"number": 7.0},
    'CONCATENATE("a",1,TRUE)': {"string": "a1TRUE"},
    "SUM(B1:B10)": {"number": 114.25},
    "AVERAGE(B1:B10)": {"number": 114.25 / 7},
    "COUNT(B1:B10)": {"number": 7.0},
}


ERROR_NAMES = {
    "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#NULL!",
}
# LibreOffice's own error numbers, as Excel names them.
LO_ERRORS = {
    "Err:502": "#NUM!",  # invalid argument
    "Err:504": "#VALUE!",  # parameter list error
    "Err:511": "#VALUE!",  # missing variable
    "Err:522": "#CYCLE!",
    "Err:523": "#NUM!",  # no convergence
}


def main() -> None:
    spec = json.loads(CASES.read_text())
    cases = spec["cases"]
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
        # Excel's comparisons: case-insensitive, wildcards in criteria, whole-cell matches.
        doc.IgnoreCase = True
        doc.Wildcards = True
        doc.RegularExpressions = False
        doc.MatchWholeCell = True
        sheets = doc.Sheets
        sheet = sheets.getByIndex(0)
        sheet.Name = "Sheet1"
        sheets.insertNewByName("Other", 1)
        other = sheets.getByName("Other")

        def put(target, col: int, row: int, v: object) -> None:
            cell = target.getCellByPosition(col, row)
            if v is None:
                return
            if isinstance(v, bool):
                cell.Formula = "=TRUE()" if v else "=FALSE()"
            elif isinstance(v, (int, float)):
                cell.Value = float(v)
            else:
                cell.String = str(v)

        for c, name in enumerate(COLUMNS):
            for r, v in enumerate(spec["data"][name]):
                put(sheet, c, r, v)
        for ref, v in spec["other"].items():
            put(other, ord(ref[0]) - 65, int(ref[1:]) - 1, v)

        for i, case in enumerate(cases):
            sheet.getCellByPosition(FORMULA_COLUMN, i).Formula = "=" + to_api(case["formula"])
        doc.calculateAll()

        golden = []
        for i, case in enumerate(cases):
            cell = sheet.getCellByPosition(FORMULA_COLUMN, i)
            kind = cell.FormulaResultType2
            shown = cell.String
            if kind == ERROR or cell.getError() != 0:
                code = shown if shown in ERROR_NAMES else LO_ERRORS.get(shown, shown)
                result = {"error": code}
            elif kind == STRING:
                result = {"string": shown}
            elif shown in ("TRUE", "FALSE") and cell.Value in (0.0, 1.0):
                result = {"boolean": shown == "TRUE"}
            else:
                result = {"number": cell.Value}
            source = "libreoffice"
            if case["formula"] in EXCEL:
                result = EXCEL[case["formula"]]
                source = "excel, by hand"
            golden.append({"fn": case["fn"], "formula": case["formula"], "row": i, **result, "source": source})
        doc.close(True)
        GOLDEN.write_text(
            json.dumps(
                {
                    "note": "What LibreOffice computes for each case of cases.json (scripts/formula-golden.py): "
                    "the data block on Sheet1 A1:F10, the other cells on Other, case i in H(i + 1).",
                    "cases": golden,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n"
        )
        print(f"wrote {GOLDEN} ({len(golden)} cases)")
    finally:
        office.terminate()
        office.wait(timeout=30)


if __name__ == "__main__":
    main()
