#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Write the four round-trip workbooks of tests/xlsx with LibreOffice.

Runs a headless LibreOffice over UNO, builds each workbook cell by cell and
saves it as Office Open XML (the "Calc MS Excel 2007 XML" filter):

- values-formulas.xlsx: numbers, text, booleans, a date, formulas (one filled
  down a column), an error, and a second sheet the first one reads;
- styles.xlsx: bold, italic, underline, strike, colours, a fill, borders,
  alignment, wrap, a font size, and number formats (built-in and custom);
- layout.xlsx: merges, column widths and row heights, a hidden row and
  column, frozen panes, three sheets;
- charts.xlsx (C10-07): twelve months of two series, and one chart of each
  type, a stacked and a percent column, a doughnut, a combo on a secondary
  axis, with titles, axis titles and limits, a legend, a series colour; the
  anchors LibreOffice writes are two-cell, so one chart's is rewritten as a
  one-cell anchor and one as an absolute anchor in the saved package.

    /usr/bin/python3 scripts/xlsx-fixtures.py
"""

from __future__ import annotations

import subprocess
import zipfile
import tempfile
import time
from pathlib import Path

import uno  # type: ignore[import-not-found]
from com.sun.star.awt import Rectangle  # type: ignore[import-not-found]
from com.sun.star.beans import PropertyValue  # type: ignore[import-not-found]
from com.sun.star.table import CellRangeAddress  # type: ignore[import-not-found]
from com.sun.star.lang import Locale  # type: ignore[import-not-found]
from com.sun.star.table import BorderLine2  # type: ignore[import-not-found]

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "xlsx"
PIPE = "cells_xlsx"


def prop(name: str, value: object) -> PropertyValue:
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def save(doc, name: str) -> None:
    url = uno.systemPathToFileUrl(str(OUT / name))
    doc.storeToURL(url, (prop("FilterName", "Calc MS Excel 2007 XML"),))
    doc.close(True)
    print(f"wrote tests/xlsx/{name}")


def values_formulas(desktop) -> None:
    doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))
    sheets = doc.Sheets
    s = sheets.getByIndex(0)
    s.Name = "Sheet1"
    sheets.insertNewByName("Data", 1)
    data = sheets.getByName("Data")
    data.getCellByPosition(0, 0).Value = 42
    data.getCellByPosition(0, 1).Value = 8
    rows = [
        ("Item", "Amount", "Double", "Running"),
        ("Rent", 1200, None, None),
        ("Food", 450.5, None, None),
        ("Transport", 349.5, None, None),
    ]
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            cell = s.getCellByPosition(c, r)
            if isinstance(v, str):
                cell.String = v
            elif v is not None:
                cell.Value = float(v)
    for r in range(1, 4):
        s.getCellByPosition(2, r).Formula = f"=B{r + 1}*2"
        s.getCellByPosition(3, r).Formula = f"=SUM(B$2:B{r + 1})"
    s.getCellByPosition(0, 5).String = "Total"
    s.getCellByPosition(1, 5).Formula = "=SUM(B2:B4)"
    s.getCellByPosition(0, 6).Formula = "=TRUE()"
    s.getCellByPosition(1, 6).Formula = "=1/0"
    s.getCellByPosition(2, 6).Formula = "=$Data.A1+$Data.A2"
    s.getCellByPosition(3, 6).Formula = '=CONCATENATE("a";"b")'
    date = s.getCellByPosition(0, 7)
    date.Value = 45000
    date.NumberFormat = doc.NumberFormats.queryKey("YYYY-MM-DD", Locale("en", "US", ""), True)
    save(doc, "values-formulas.xlsx")


def styles(desktop) -> None:
    doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))
    s = doc.Sheets.getByIndex(0)
    s.Name = "Styles"
    formats = doc.NumberFormats
    locale = Locale("en", "US", "")

    def fmt(code: str) -> int:
        key = formats.queryKey(code, locale, True)
        return key if key != -1 else formats.addNew(code, locale)

    def put(ref: str, value, **props) -> None:
        cell = s.getCellRangeByName(ref)
        if isinstance(value, str):
            cell.String = value
        else:
            cell.Value = float(value)
        for k, v in props.items():
            setattr(cell, k, v)

    put("A1", "bold", CharWeight=150.0)
    put("A2", "italic", CharPosture=2)
    put("A3", "underline", CharUnderline=1)
    put("A4", "strike", CharStrikeout=1)
    put("A5", "red", CharColor=0xFF0000)
    put("A6", "filled", CellBackColor=0xFFFF00)
    put("A7", "big", CharHeight=16.0)
    put("A8", "right", HoriJustify=3)
    put("A9", "centred", HoriJustify=2)
    put("A10", "wrapped text that is long", IsTextWrapped=True)
    line = BorderLine2()
    line.OuterLineWidth = 26
    line.LineWidth = 26
    line.Color = 0x0000FF
    put("A11", "boxed", TopBorder=line, BottomBorder=line, LeftBorder=line, RightBorder=line)
    put("B1", 1234.5, NumberFormat=fmt("#,##0.00"))
    put("B2", 0.25, NumberFormat=fmt("0%"))
    put("B3", 45000, NumberFormat=fmt("YYYY-MM-DD"))
    put("B4", 1234.5, NumberFormat=fmt('"$"#,##0.00'))
    put("B5", 0.5, NumberFormat=fmt("0.00E+00"))
    save(doc, "styles.xlsx")


def layout(desktop) -> None:
    doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))
    sheets = doc.Sheets
    s = sheets.getByIndex(0)
    s.Name = "Layout"
    sheets.insertNewByName("Second", 1)
    sheets.insertNewByName("Third sheet", 2)
    for r in range(6):
        for c in range(4):
            s.getCellByPosition(c, r).String = f"{chr(65 + c)}{r + 1}"
    s.getCellRangeByName("A1:B2").merge(True)
    s.getCellRangeByName("C5:D6").merge(True)
    cols = s.Columns
    cols.getByIndex(0).Width = 4000  # 1/100 mm
    cols.getByIndex(2).IsVisible = False
    rows = s.Rows
    rows.getByIndex(1).Height = 1000
    rows.getByIndex(3).IsVisible = False
    sheets.getByName("Second").getCellByPosition(0, 0).String = "second"
    sheets.getByName("Third sheet").getCellByPosition(1, 1).Value = 3
    save(doc, "layout.xlsx")
    # A hidden document has no view to freeze: the frozen pane (one column, two rows) is
    # written into the saved sheet's view, as Excel writes it.
    freeze(OUT / "layout.xlsx", "xl/worksheets/sheet1.xml", cols=1, rows=2)


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def charts(desktop, ctx) -> None:
    doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))
    s = doc.Sheets.getByIndex(0)
    s.Name = "Figures"
    for c, h in enumerate(("Month", "North", "South")):
        s.getCellByPosition(c, 0).String = h
    for r, m in enumerate(MONTHS):
        s.getCellByPosition(0, r + 1).String = m
        s.getCellByPosition(1, r + 1).Value = 10 + (r * 7) % 11
        s.getCellByPosition(2, r + 1).Value = 5 + (r * 5) % 9
    # A scatter's x and y.
    s.getCellByPosition(4, 0).String = "x"
    s.getCellByPosition(5, 0).String = "y"
    for r in range(6):
        s.getCellByPosition(4, r + 1).Value = r + 1
        s.getCellByPosition(5, r + 1).Value = (r + 1) ** 2

    def rng(c0: int, r0: int, c1: int, r1: int) -> CellRangeAddress:
        a = CellRangeAddress()
        a.Sheet, a.StartColumn, a.StartRow, a.EndColumn, a.EndRow = 0, c0, r0, c1, r1
        return a

    def rect(x_mm: int, y_mm: int) -> Rectangle:
        r = Rectangle()
        r.X, r.Y, r.Width, r.Height = x_mm * 100, y_mm * 100, 9000, 6000
        return r

    def add(name: str, pos: tuple[int, int], ranges, diagram: str, title: str, **props) -> object:
        s.Charts.addNewByName(name, rect(*pos), ranges, True, True)
        chart = s.Charts.getByName(name).EmbeddedObject
        chart.Diagram = chart.createInstance(f"com.sun.star.chart.{diagram}")
        for k, v in props.items():
            setattr(chart.Diagram, k, v)
        chart.HasMainTitle = True
        chart.Title.String = title
        chart.HasLegend = True
        chart.Legend.Alignment = uno.Enum("com.sun.star.chart.ChartLegendPosition", "BOTTOM")
        return chart

    both = (rng(0, 0, 2, 12),)
    column = add("column", (120, 10), both, "BarDiagram", "Column")
    column.Diagram.getDataRowProperties(0).FillColor = 0x1F77B4
    column.Diagram.HasYAxisTitle = True
    column.Diagram.YAxisTitle.String = "Units"
    column.Diagram.YAxis.AutoMin = False
    column.Diagram.YAxis.Min = 0.0
    column.Diagram.YAxis.AutoMax = False
    column.Diagram.YAxis.Max = 25.0
    column.Diagram.HasXAxisTitle = True
    column.Diagram.XAxisTitle.String = "Month"
    add("stacked", (120, 80), both, "BarDiagram", "Stacked", Stacked=True, HasYAxisGrid=False)
    add("percent", (120, 150), both, "BarDiagram", "Percent", Percent=True)
    add("bar", (120, 220), both, "BarDiagram", "Bar", Vertical=True)
    line = add("line", (220, 10), both, "LineDiagram", "Line")
    line.Diagram.HasYAxisGrid = True
    add("area", (220, 80), both, "AreaDiagram", "Area")
    add("pie", (220, 150), (rng(0, 0, 1, 12),), "PieDiagram", "Pie")
    add("doughnut", (220, 220), (rng(0, 0, 1, 12),), "DonutDiagram", "Doughnut")
    add("scatter", (320, 10), (rng(4, 0, 5, 6),), "XYDiagram", "Scatter")
    combo = add("combo", (320, 80), both, "BarDiagram", "Combo")
    # The combo: the second series as a line on a secondary axis, through the chart2 API.
    diagram = combo.getFirstDiagram()
    cs = diagram.getCoordinateSystems()[0]
    bars = cs.getChartTypes()[0]
    series = bars.getDataSeries()
    smgr = ctx.ServiceManager
    lines = smgr.createInstanceWithContext("com.sun.star.chart2.LineChartType", ctx)
    cs.addChartType(lines)
    bars.setDataSeries((series[0],))
    lines.setDataSeries((series[1],))
    series[1].AttachedAxisIndex = 1
    axis = smgr.createInstanceWithContext("com.sun.star.chart2.Axis", ctx)
    cs.setAxisByDimension(1, axis, 1)
    save(doc, "charts.xlsx")
    anchors(OUT / "charts.xlsx")


def anchors(path: Path) -> None:
    """LibreOffice writes two-cell anchors only: the pie's becomes a one-cell anchor, the doughnut's an absolute one."""
    import re

    with zipfile.ZipFile(path) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in items:
            if info.filename.startswith("xl/drawings/drawing") and info.filename.endswith(".xml"):
                xml = data.decode()
                anchors_ = re.findall(r"<xdr:twoCellAnchor.*?</xdr:twoCellAnchor>", xml, flags=re.S)
                for n, a in enumerate(anchors_):
                    frm = re.search(r"<xdr:from>.*?</xdr:from>", a, flags=re.S).group(0)
                    body = re.search(r"</xdr:to>(.*)</xdr:twoCellAnchor>", a, flags=re.S).group(1)
                    if n == 6:  # the pie
                        new = f'<xdr:oneCellAnchor>{frm}<xdr:ext cx="3240000" cy="2160000"/>{body}</xdr:oneCellAnchor>'
                        xml = xml.replace(a, new)
                    elif n == 7:  # the doughnut
                        new = f'<xdr:absoluteAnchor><xdr:pos x="7620000" y="8572500"/><xdr:ext cx="3240000" cy="2160000"/>{body}</xdr:absoluteAnchor>'
                        xml = xml.replace(a, new)
                data = xml.encode()
            z.writestr(info, data)


def freeze(path: Path, part: str, cols: int, rows: int) -> None:
    with zipfile.ZipFile(path) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    pane = (
        f'<pane xSplit="{cols}" ySplit="{rows}" topLeftCell="{chr(65 + cols)}{rows + 1}" '
        'activePane="bottomRight" state="frozen"/>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in items:
            if info.filename == part:
                xml = data.decode()
                i = xml.index("<sheetView ")
                j = xml.index(">", i) + 1
                data = (xml[:j] + pane + xml[j:]).encode()
            z.writestr(info, data)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
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
        values_formulas(desktop)
        styles(desktop)
        layout(desktop)
        charts(desktop, ctx)
    finally:
        office.terminate()
        office.wait(timeout=30)


if __name__ == "__main__":
    main()
