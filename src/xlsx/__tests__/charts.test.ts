/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C10-07: charts in XLSX. The LibreOffice fixture (scripts/xlsx-fixtures.py)
 * imports with its types, ranges, titles, axes, legend, colours and anchors;
 * hand-written parts give one report line each for what is not drawn; and
 * every type round-trips through the writer and the reader.
 */

import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { type ChartSpec, createCellsModel } from '../../core/index.js';
import { readXlsx, writeXlsx } from '../index.js';

const fixture = () =>
  readXlsx(
    new Uint8Array(readFileSync(new URL('../../../tests/xlsx/charts.xlsx', import.meta.url))),
  );

describe('the LibreOffice charts workbook', () => {
  const { workbook, report } = fixture();
  const charts = Object.values(workbook.sheets[0].charts ?? {});
  const by = (title: string) => charts.find((c) => c.title === title)!;

  it('imports the ten charts, none reported', () => {
    expect(report.chartsImported).toBe(10);
    expect(report.charts).toEqual([]);
    expect(charts.map((c) => c.title)).toEqual([
      'Column',
      'Stacked',
      'Percent',
      'Bar',
      'Line',
      'Area',
      'Pie',
      'Doughnut',
      'Scatter',
      'Combo',
    ]);
  });

  it('types and variants', () => {
    expect(charts.map((c) => [c.type, c.variant])).toEqual([
      ['column', undefined],
      ['column', 'stacked'],
      ['column', 'percent'],
      ['bar', undefined],
      ['line', undefined],
      ['area', undefined],
      ['pie', undefined],
      ['pie', 'doughnut'],
      ['scatter', undefined],
      ['combo', undefined],
    ]);
  });

  it('ranges, names and categories, as Excel writes them', () => {
    const column = by('Column');
    expect(column.data.series).toHaveLength(2);
    expect(column.data.series[0]).toMatchObject({
      name: 'Figures!$B$1',
      values: 'Figures!$B$2:$B$13',
      categories: 'Figures!$A$2:$A$13',
      color: '#1f77b4',
    });
    expect(column.data.series[1].color).toMatch(/^#[0-9a-f]{6}$/); // LibreOffice writes every series' colour
    expect(column.data).toMatchObject({ by: 'columns', headers: { row: true, column: true } });
    expect(by('Scatter').data.series[0]).toMatchObject({
      x: 'Figures!$E$2:$E$7',
      values: 'Figures!$F$2:$F$7',
    });
    expect(by('Pie').data.series).toHaveLength(1);
  });

  it('titles, axes, legend', () => {
    const column = by('Column');
    expect(column.legend).toBe('bottom');
    expect(column.axes?.y).toMatchObject({ title: 'Units', min: 0, max: 25 });
    expect(column.axes?.x).toMatchObject({ title: 'Month' });
    expect(by('Line').axes?.y?.gridlines).not.toBe(false); // the default: a value axis has them
    expect(by('Stacked').axes?.y?.gridlines).toBe(false);
  });

  it('the combo: a column and a line, the line on the secondary axis', () => {
    const combo = by('Combo');
    expect(combo.data.series.map((s) => [s.type, s.axis])).toEqual([
      ['column', undefined],
      ['line', 'secondary'],
    ]);
    expect(combo.axes?.y2).toBeDefined();
  });

  it('the three anchors: two-cell, one-cell, absolute', () => {
    expect(by('Column').anchor.kind).toBe('cells');
    const cells = by('Column').anchor as {
      from: { row: number; col: number };
      to: { row: number };
    };
    expect(cells.from.col).toBe(5);
    expect(cells.to.row).toBeGreaterThan(cells.from.row);
    expect(by('Pie').anchor).toMatchObject({ kind: 'cell', width: 340, height: 227 });
    expect(by('Doughnut').anchor).toMatchObject({ kind: 'absolute', x: 800, y: 900, width: 340 });
  });

  it('loads into a model and draws: every chart has numbers', () => {
    const m = createCellsModel({ data: workbook });
    for (const c of charts) {
      const data = m.chartData(m.sheets[0].id, c.id);
      expect(data.deleted).toEqual([]);
      expect(data.series[0].values.some((v) => typeof v === 'number')).toBe(true);
    }
    expect(m.chartData(m.sheets[0].id, by('Column').id).categories).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });
});

// ------------------------------------------------------------------ hand-written parts

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

const ser = (vals = 'Sheet1!$B$2:$B$4', extra = '') =>
  `<c:ser><c:idx val="0"/><c:order val="0"/>${extra}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${vals}</c:f></c:numRef></c:val></c:ser>`;
const axes =
  '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
  '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>';
const chartSpace = (plot: string) =>
  `${XML}<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>${plot}${axes}</c:plotArea><c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>`;

/** A one-sheet package with the given chart parts (or `cx:` parts), each anchored on the sheet. */
function pkg(
  parts: { xml: string; ex?: boolean }[],
  extraFiles: Record<string, string> = {},
): Uint8Array {
  const anchors = parts
    .map(
      (p, i) =>
        `<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i * 10}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i * 10 + 8}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        (p.ex
          ? `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="cx1"><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:r="${R}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice><mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr/></xdr:nvSpPr></xdr:sp></mc:Fallback></mc:AlternateContent>`
          : `<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame>`) +
        '<xdr:clientData/></xdr:twoCellAnchor>',
    )
    .join('');
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[path] = strToU8(text));
  put(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  put(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  put(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  put(
    'xl/_rels/workbook.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  put(
    'xl/worksheets/sheet1.xml',
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c><c r="B1" t="inlineStr"><is><t>V</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>2</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4"><v>3</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>`,
  );
  put(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  );
  put(
    'xl/drawings/drawing1.xml',
    `${XML}<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${anchors}</xdr:wsDr>`,
  );
  put(
    'xl/drawings/_rels/drawing1.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts
      .map((p, i) =>
        p.ex
          ? `<Relationship Id="rId${i + 1}" Type="http://schemas.microsoft.com/office/2014/relationships/chartEx" Target="../charts/chartEx${i + 1}.xml"/>`
          : `<Relationship Id="rId${i + 1}" Type="${R}/chart" Target="../charts/chart${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  parts.forEach((p, i) =>
    put(p.ex ? `xl/charts/chartEx${i + 1}.xml` : `xl/charts/chart${i + 1}.xml`, p.xml),
  );
  for (const [path, text] of Object.entries(extraFiles)) put(path, text);
  return zipSync(files);
}

describe('what the import report says', () => {
  it('a 3-D column chart is imported as a column chart, with a line', () => {
    const { workbook, report } = readXlsx(
      pkg([
        {
          xml: chartSpace(
            `<c:bar3DChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser()}<c:axId val="1"/><c:axId val="2"/></c:bar3DChart>`,
          ),
        },
      ]),
    );
    expect(report.chartsImported).toBe(1);
    expect(report.charts).toEqual([
      "Sheet1: chart 'chart1': a 3-D chart was imported as a column chart.",
    ]);
    expect(Object.values(workbook.sheets[0].charts!)[0]).toMatchObject({
      type: 'column',
      legend: 'right',
    });
  });

  it.each([
    [
      'radar',
      `<c:radarChart><c:radarStyle val="marker"/>${ser()}<c:axId val="1"/><c:axId val="2"/></c:radarChart>`,
    ],
    ['bubble', `<c:bubbleChart>${ser()}<c:axId val="1"/><c:axId val="2"/></c:bubbleChart>`],
    ['stock', `<c:stockChart>${ser()}<c:axId val="1"/><c:axId val="2"/></c:stockChart>`],
  ])('a %s chart is not imported, with a line', (kind, plot) => {
    const { workbook, report } = readXlsx(pkg([{ xml: chartSpace(plot) }]));
    expect(report.chartsImported).toBe(0);
    expect(workbook.sheets[0].charts).toBeUndefined();
    expect(report.charts).toEqual([`Sheet1: chart 'chart1': a ${kind} chart was not imported.`]);
  });

  it('a cx: part (Excel 2016 types) is not imported, named by its layout', () => {
    const { report } = readXlsx(
      pkg([
        {
          ex: true,
          xml: `${XML}<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall" uniqueId="{1}"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`.replace(
            'layoutId="waterfall" uniqueId="{1}"/>',
            'uniqueId="{1}"><cx:layoutId val="waterfall"/></cx:series>',
          ),
        },
      ]),
    );
    expect(report.chartsImported).toBe(0);
    expect(report.charts).toEqual([
      "Sheet1: chart 'chart1': an Excel 2016 chart (waterfall) was not imported.",
    ]);
  });

  it('a chart sheet is not imported', () => {
    const { report } = readXlsx(
      pkg([], {
        'xl/chartsheets/sheet1.xml': `${XML}<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`,
      }),
    );
    expect(report.charts).toEqual(['xl/chartsheets/sheet1.xml: a chart sheet was not imported.']);
  });

  it('a series given as literals is left out; one naming another workbook too', () => {
    const literal =
      '<c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:val></c:ser>';
    const external = ser("'[Other.xlsx]Sheet1'!$B$2:$B$4");
    const { workbook, report } = readXlsx(
      pkg([
        {
          xml: chartSpace(
            `<c:barChart><c:barDir val="col"/>${literal}${external}${ser()}<c:axId val="1"/><c:axId val="2"/></c:barChart>`,
          ),
        },
      ]),
    );
    expect(report.chartsImported).toBe(1);
    expect(Object.values(workbook.sheets[0].charts!)[0].data.series).toHaveLength(1);
    expect(report.charts).toEqual([
      "Sheet1: chart 'chart1': a series given as literals was not imported.",
      "Sheet1: chart 'chart1': a series naming another workbook was not imported.",
    ]);
  });

  it('a trendline, error bars and per-point colours are left out, the series kept', () => {
    const extra =
      '<c:dPt><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt>' +
      '<c:trendline><c:trendlineType val="linear"/></c:trendline><c:errBars><c:errBarType val="both"/></c:errBars>';
    const { workbook, report } = readXlsx(
      pkg([
        {
          xml: chartSpace(
            `<c:lineChart><c:grouping val="standard"/>${ser(undefined, extra)}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`,
          ),
        },
      ]),
    );
    const chart = Object.values(workbook.sheets[0].charts!)[0];
    expect(chart.data.series[0].color).toBeUndefined(); // the point's colour is not the series'
    expect(report.charts).toEqual([
      "Sheet1: chart 'chart1': 1 per-point colour(s) were left out.",
      "Sheet1: chart 'chart1': 1 trendline(s) were left out.",
      "Sheet1: chart 'chart1': error bars were left out.",
    ]);
  });

  it('a pivot chart is not imported', () => {
    const { report } = readXlsx(
      pkg([
        {
          xml: chartSpace('').replace(
            '<c:chart>',
            '<c:chart><c:pivotSource><c:name>P</c:name><c:fmtId val="0"/></c:pivotSource>',
          ),
        },
      ]),
    );
    expect(report.charts).toEqual(["Sheet1: chart 'chart1': a pivot chart was not imported."]);
  });
});

// ------------------------------------------------------------------ round trip

const SPECS = (
  [
    { type: 'column' },
    { type: 'column', variant: 'stacked', labels: true },
    { type: 'column', variant: 'percent', legend: 'right' },
    { type: 'bar', legend: 'none' },
    {
      type: 'line',
      variant: 'smooth',
      axes: {
        x: { title: 'Month' },
        y: { title: 'Units', min: 0, max: 30, format: '0.0' },
      },
    },
    { type: 'area', variant: 'stacked', axes: { y: { log: true, gridlines: false } } },
    { type: 'pie', legend: 'top' },
    { type: 'pie', variant: 'doughnut', legend: 'left' },
  ] as Partial<ChartSpec>[]
).map((over, i) => ({
  anchor:
    i % 3 === 0
      ? {
          kind: 'cells',
          from: { row: 1 + i, col: 5, dx: 3, dy: 4 },
          to: { row: 12 + i, col: 10, dx: 0, dy: 7 },
        }
      : i % 3 === 1
        ? { kind: 'cell', from: { row: 1 + i, col: 5, dx: 0, dy: 0 }, width: 400, height: 250 }
        : { kind: 'absolute', x: 10 * i, y: 20 * i, width: 320, height: 200 },
  data: {
    series: [
      {
        name: 'Figures!$B$1',
        values: 'Figures!$B$2:$B$5',
        categories: 'Figures!$A$2:$A$5',
        color: '#aabbcc',
      },
      { name: 'Southern', values: 'Figures!$C$2:$C$5', categories: 'Figures!$A$2:$A$5' },
    ],
    by: 'columns',
    headers: { row: true, column: true },
    blanks: i % 2 === 0 ? 'gap' : 'zero',
  },
  title: `Chart ${i + 1}`,
  legend: 'bottom',
  ...over,
})) as Omit<ChartSpec, 'id'>[];

function model() {
  const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
  m.dispatch({ type: 'RENAME_SHEET', sheet: 's1', name: 'Figures' });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'North', 'South', 'x', 'y'],
      ['Jan', 10, 7, 1, 1],
      ['Feb', 12, 9, 2, 4],
      ['Mar', 15, 11, 3, 9],
      ['Apr', 13, 14, 4, 16],
    ],
  });
  return m;
}

/** A spec with the fields the format does not carry removed, for comparison. */
const comparable = (c: ChartSpec) => {
  const { id: _id, ...rest } = c;
  return JSON.parse(JSON.stringify(rest));
};

describe('round trip', () => {
  it('every type, variant and anchor: written, read, the same', () => {
    const m = model();
    for (const spec of SPECS)
      expect(m.dispatch({ type: 'INSERT_CHART', sheet: 's1', chart: spec })).toEqual({ ok: true });
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: {
        ...SPECS[0],
        type: 'scatter',
        title: 'Scatter',
        data: {
          series: [{ name: 'y', values: 'Figures!$E$2:$E$5', x: 'Figures!$D$2:$D$5' }],
          by: 'columns',
          headers: { row: true, column: false },
          blanks: 'gap',
        },
      },
    });
    m.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: {
        ...SPECS[0],
        type: 'combo',
        title: 'Combo',
        axes: { y: { title: 'Left' }, y2: { title: 'Right', max: 20 } },
        data: {
          series: [
            {
              name: 'Figures!$B$1',
              values: 'Figures!$B$2:$B$5',
              categories: 'Figures!$A$2:$A$5',
              type: 'column',
            },
            {
              name: 'Figures!$C$1',
              values: 'Figures!$C$2:$C$5',
              categories: 'Figures!$A$2:$A$5',
              type: 'line',
              axis: 'secondary',
            },
            {
              name: 'Figures!$E$1',
              values: 'Figures!$E$2:$E$5',
              categories: 'Figures!$A$2:$A$5',
              type: 'area',
            },
          ],
          by: 'columns',
          headers: { row: true, column: true },
          blanks: 'connect',
        },
      },
    });
    const { workbook, report } = readXlsx(writeXlsx(m));
    expect(report.charts).toEqual([]);
    expect(report.chartsImported).toBe(10);
    const back = Object.values(workbook.sheets[0].charts!);
    const original = [...m.sheet('s1').charts.values()];
    expect(back.map(comparable)).toEqual(original.map(comparable));
    // And read into a model, the data is the same.
    const m2 = createCellsModel({ data: workbook });
    for (const c of back)
      expect(m2.chartData(m2.sheets[0].id, c.id)).toEqual(m.chartData('s1', c.id));
  });
});
