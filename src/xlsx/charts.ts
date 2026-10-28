/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Charts in XLSX (§3.12): DrawingML, ECMA-376 Part 1 §20 and §21, read and
 * written here and never in `./charts`, so reading a file needs no ECharts.
 *
 * Read: the sheet's `<drawing r:id>` → `xl/drawings/drawingN.xml` → an
 * anchor (`twoCellAnchor`, `oneCellAnchor`, `absoluteAnchor`) holding a
 * `graphicFrame` → `c:chart r:id` → `xl/charts/chartN.xml`, whose
 * `c:plotArea` holds `c:barChart` (`c:barDir`, `c:grouping`), `c:lineChart`,
 * `c:areaChart`, `c:pieChart`, `c:doughnutChart` and `c:scatterChart`;
 * several groups in one plot area, one on a second value axis, is a combo.
 * What is not drawn goes to the import report, one line each: 3-D charts
 * (imported as their 2-D type), radar, bubble, stock and surface charts,
 * Excel 2016's `cx:` parts, chart sheets, pivot charts, literal series,
 * per-point colours, trendlines, error bars.
 *
 * Write: the same parts with their relationships and content types, plus
 * `c:numCache` and `c:strCache` of the current values, which Excel and
 * LibreOffice expect.
 *
 * @module xlsx/charts
 */

import type { CellsModel } from '../core/model.js';
import type {
  ChartAnchor,
  ChartAxis,
  ChartSeries,
  ChartSpec,
  CellOffset,
  Ref,
} from '../core/charts.js';
import { refZone } from '../core/charts.js';
import type { CellValue } from '../core/values.js';
import { type Attributes, escape, scan } from './xml.js';

/** EMU per CSS px at 96 dpi. */
const EMU = 9525;
const emuToPx = (v: string | undefined) => Math.round(Number(v ?? 0) / EMU);
const pxToEmu = (px: number) => Math.round(px * EMU);

export const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
export const DML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const CHART_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
export const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';

// ------------------------------------------------------------------ reading

/** The theme's accent colours, as `a:schemeClr val="accentN"` maps onto `chartColors[N-1]`: left to the theme, not stored. */
const SCHEME_ACCENT = /^accent([1-6])$/;

interface RawSeries {
  /** `c:idx`: the series' place in the chart, across the groups of a combo. */
  idx: number;
  name?: Ref | string;
  values?: Ref;
  categories?: Ref;
  x?: Ref;
  color?: string;
  smooth?: boolean;
  /** The series had a literal (`c:numLit`, `c:strLit`) where a range was expected. */
  literal: boolean;
  dPt: number;
  trendline: number;
  errBars: number;
  /** Named another workbook (`[Book1.xlsx]Sheet1!…`). */
  external: boolean;
}

interface RawGroup {
  /** The DrawingML element: `barChart`, `line3DChart`, … */
  element: string;
  barDir?: string;
  grouping?: string;
  holeSize?: boolean;
  series: RawSeries[];
  axIds: string[];
  showVal?: boolean;
}

interface RawAxis {
  element: 'catAx' | 'valAx' | 'dateAx' | 'serAx';
  id: string;
  title?: string;
  min?: number;
  max?: number;
  log?: boolean;
  gridlines: boolean;
  format?: string;
  deleted: boolean;
}

interface RawChart {
  title?: string;
  autoTitleDeleted: boolean;
  legend?: string;
  dispBlanksAs?: string;
  groups: RawGroup[];
  axes: RawAxis[];
  pivot: boolean;
  /** The `c:plotArea` held an element that is not drawn: `radarChart`, `bubbleChart`, … */
  undrawn: string[];
}

/** The text of a `c:title` or an axis title: every `a:t` run joined. */
function textOf(parts: string[]): string | undefined {
  const t = parts.join('');
  return t === '' ? undefined : t;
}

const GROUPS = new Set([
  'barChart',
  'bar3DChart',
  'lineChart',
  'line3DChart',
  'areaChart',
  'area3DChart',
  'pieChart',
  'pie3DChart',
  'doughnutChart',
  'ofPieChart',
  'scatterChart',
  'radarChart',
  'bubbleChart',
  'stockChart',
  'surfaceChart',
  'surface3DChart',
]);
const DRAWN = new Set([
  'barChart',
  'bar3DChart',
  'lineChart',
  'line3DChart',
  'areaChart',
  'area3DChart',
  'pieChart',
  'pie3DChart',
  'doughnutChart',
  'scatterChart',
]);

/** Parse a `xl/charts/chartN.xml` part into what the mapping needs. */
export function parseChartPart(xml: string): RawChart {
  const chart: RawChart = {
    autoTitleDeleted: false,
    groups: [],
    axes: [],
    pivot: false,
    undrawn: [],
  };
  const path: string[] = [];
  let group: RawGroup | undefined;
  let series: RawSeries | undefined;
  let axis: RawAxis | undefined;
  /** Where a `c:f` or `a:t` text lands. */
  let text: string[] | undefined;
  let textFor: 'name' | 'values' | 'categories' | 'x' | 'title' | 'axisTitle' | undefined;
  let fText = '';
  let inTitle = 0;
  const has = (name: string) => path.includes(name);
  scan(xml, {
    open(name, a: Attributes) {
      path.push(name);
      if (GROUPS.has(name) && has('plotArea')) {
        group = { element: name, series: [], axIds: [] };
        chart.groups.push(group);
        if (!DRAWN.has(name)) chart.undrawn.push(name);
        return;
      }
      if (name === 'pivotSource') chart.pivot = true;
      if (name === 'autoTitleDeleted') chart.autoTitleDeleted = a.val === '1' || a.val === 'true';
      if (name === 'legendPos') chart.legend = a.val;
      if (name === 'dispBlanksAs') chart.dispBlanksAs = a.val;
      if (name === 'title' && !has('ser')) {
        inTitle += 1;
        text = [];
        textFor = axis !== undefined && has(axis.element) ? 'axisTitle' : 'title';
        return;
      }
      if (group !== undefined && !has('ser')) {
        if (name === 'barDir') group.barDir = a.val;
        else if (name === 'grouping') group.grouping = a.val;
        else if (name === 'holeSize') group.holeSize = true;
        else if (name === 'axId') group.axIds.push(a.val);
        else if (name === 'showVal' && has('dLbls'))
          group.showVal = a.val === '1' || a.val === 'true';
      }
      if (name === 'ser' && group !== undefined) {
        series = { idx: 1e9, literal: false, dPt: 0, trendline: 0, errBars: 0, external: false };
        group.series.push(series);
        return;
      }
      if (series !== undefined) {
        if (name === 'idx' && !has('dPt') && !has('dLbl')) series.idx = Number(a.val);
        else if (name === 'tx') textFor = 'name';
        else if (name === 'val' || name === 'yVal') textFor = 'values';
        else if (name === 'cat') textFor = 'categories';
        else if (name === 'xVal') textFor = 'x';
        else if (name === 'f') fText = '';
        else if (name === 'numLit' || name === 'strLit') series.literal = true;
        else if (
          name === 'dPt' &&
          group !== undefined &&
          !group.element.startsWith('pie') &&
          group.element !== 'doughnutChart'
        )
          series.dPt += 1; // a pie's slices are coloured one by one by every writer
        else if (name === 'trendline') series.trendline += 1;
        else if (name === 'errBars') series.errBars += 1;
        else if (name === 'smooth') series.smooth = a.val !== '0' && a.val !== 'false';
        else if (
          name === 'srgbClr' &&
          has('spPr') &&
          has('solidFill') &&
          !has('dPt') &&
          series.color === undefined
        )
          series.color = `#${a.val.toLowerCase()}`;
        else if (name === 'v' && textFor === 'name' && has('tx') && !has('strRef')) text = [];
      }
      if (
        (name === 'catAx' || name === 'valAx' || name === 'dateAx' || name === 'serAx') &&
        has('plotArea')
      ) {
        axis = { element: name, id: '', gridlines: false, deleted: false };
        chart.axes.push(axis);
        return;
      }
      if (axis !== undefined && has(axis.element)) {
        if (name === 'axId') axis.id = a.val;
        else if (name === 'min') axis.min = Number(a.val);
        else if (name === 'max') axis.max = Number(a.val);
        else if (name === 'logBase') axis.log = true;
        else if (name === 'majorGridlines') axis.gridlines = true;
        else if (
          name === 'numFmt' &&
          a.formatCode !== undefined &&
          a.formatCode !== 'General' &&
          a.sourceLinked !== '1' &&
          a.sourceLinked !== 'true'
        )
          axis.format = a.formatCode;
        else if (name === 'delete') axis.deleted = a.val === '1' || a.val === 'true';
      }
    },
    text(t) {
      if (has('f')) fText += t;
      else if (text !== undefined && (has('t') || (has('v') && textFor === 'name'))) text.push(t);
    },
    close(name) {
      path.pop();
      if (
        name === 'f' &&
        series !== undefined &&
        textFor !== undefined &&
        textFor !== 'title' &&
        textFor !== 'axisTitle'
      ) {
        const ref = fText.trim();
        if (/^\[/.test(ref) || /'\[/.test(ref)) series.external = true;
        else series[textFor] = ref;
      }
      if (
        name === 'v' &&
        series !== undefined &&
        textFor === 'name' &&
        text !== undefined &&
        !has('strRef')
      ) {
        series.name = text.join('');
        text = undefined;
      }
      if (name === 'tx' || name === 'val' || name === 'yVal' || name === 'cat' || name === 'xVal') {
        if (series !== undefined) textFor = undefined;
      }
      if (name === 'title' && inTitle > 0) {
        inTitle -= 1;
        const value = textOf(text ?? []);
        if (textFor === 'axisTitle' && axis !== undefined) axis.title = value;
        else if (textFor === 'title') chart.title = value;
        text = undefined;
        textFor = undefined;
      }
      if (name === 'ser') series = undefined;
      if (GROUPS.has(name)) group = undefined;
      if (name === 'catAx' || name === 'valAx' || name === 'dateAx' || name === 'serAx')
        axis = undefined;
    },
  });
  return chart;
}

const LEGEND: Record<string, ChartSpec['legend']> = {
  t: 'top',
  r: 'right',
  b: 'bottom',
  l: 'left',
  tr: 'right',
};

/** A sheet name and a cell-range text as Cells' `Ref`: Excel's `c:f` is already in that form. */
const asRef = (f: string): Ref => f;

/** One report line per thing not drawn, and the spec of a chart part. */
export function chartFromPart(
  raw: RawChart,
  id: string,
  anchor: ChartAnchor,
  sheetName: string,
  report: string[],
): ChartSpec | undefined {
  const where = `${sheetName}: chart '${id}'`;
  if (raw.pivot) {
    report.push(`${where}: a pivot chart was not imported.`);
    return undefined;
  }
  for (const u of raw.undrawn)
    report.push(`${where}: a ${u.replace(/Chart$/, '')} chart was not imported.`);
  const groups = raw.groups.filter((g) => DRAWN.has(g.element));
  if (groups.length === 0) {
    if (raw.undrawn.length === 0) report.push(`${where}: no chart that Cells draws.`);
    return undefined;
  }
  const threeD = groups.filter((g) => g.element.includes('3D'));
  const kindOf = (g: RawGroup): 'column' | 'bar' | 'line' | 'area' | 'pie' | 'scatter' => {
    switch (g.element) {
      case 'barChart':
      case 'bar3DChart':
        return g.barDir === 'bar' ? 'bar' : 'column';
      case 'lineChart':
      case 'line3DChart':
        return 'line';
      case 'areaChart':
      case 'area3DChart':
        return 'area';
      case 'pieChart':
      case 'pie3DChart':
      case 'doughnutChart':
        return 'pie';
      default:
        return 'scatter';
    }
  };
  // The value axes, in document order: a group on the second is on the secondary axis.
  const valAxes = raw.axes.filter((a) => a.element === 'valAx');
  const primaryVal = valAxes[0];
  const allScatter = groups.every((g) => g.element === 'scatterChart');
  const secondaryVal = allScatter
    ? undefined
    : valAxes.find((a) => a !== primaryVal && groups.some((g) => g.axIds.includes(a.id)));
  const catAxis = raw.axes.find(
    (a) =>
      a.element === 'catAx' ||
      a.element === 'dateAx' ||
      (a.element === 'valAx' &&
        groups.every((g) => g.element === 'scatterChart') &&
        a === primaryVal),
  );
  const combo = groups.length > 1;
  let type: string = combo ? 'combo' : kindOf(groups[0]);
  if (
    combo &&
    groups.some(
      (g) =>
        g.element.startsWith('pie') ||
        g.element === 'doughnutChart' ||
        g.element === 'scatterChart',
    )
  ) {
    // A pie or a scatter beside another group: keep the first group's kind, the rest is not drawn.
    type = kindOf(groups[0]);
    for (const g of groups.slice(1))
      report.push(
        `${where}: a second plot (${g.element.replace(/Chart$/, '')}) beside a ${type} chart was not imported.`,
      );
    groups.length = 1;
  }
  if (threeD.length > 0) report.push(`${where}: a 3-D chart was imported as a ${type} chart.`);
  let variant: ChartSpec['variant'] | undefined;
  const first = groups[0];
  if (first.element === 'doughnutChart') variant = 'doughnut';
  else if (first.grouping === 'stacked') variant = 'stacked';
  else if (first.grouping === 'percentStacked') variant = 'percent';
  else if (
    (first.element === 'lineChart' || first.element === 'line3DChart') &&
    first.series.some((s) => s.smooth)
  )
    variant = 'smooth';
  const series: ChartSeries[] = [];
  const dropped: string[] = [];
  const ordered: [number, ChartSeries][] = [];
  for (const g of groups) {
    const kind = kindOf(g);
    const secondary = secondaryVal !== undefined && g.axIds.includes(secondaryVal.id);
    for (const s of g.series) {
      if (s.values === undefined) {
        dropped.push(
          s.external
            ? 'a series naming another workbook'
            : s.literal
              ? 'a series given as literals'
              : 'a series without values',
        );
        continue;
      }
      if (s.literal)
        report.push(`${where}: literal categories or names of a series were left out.`);
      if (s.dPt > 0) report.push(`${where}: ${s.dPt} per-point colour(s) were left out.`);
      if (s.trendline > 0) report.push(`${where}: ${s.trendline} trendline(s) were left out.`);
      if (s.errBars > 0) report.push(`${where}: error bars were left out.`);
      ordered.push([
        s.idx,
        {
          values: asRef(s.values),
          ...(s.name !== undefined ? { name: s.name } : {}),
          ...(s.categories !== undefined ? { categories: asRef(s.categories) } : {}),
          ...(s.x !== undefined ? { x: asRef(s.x) } : {}),
          ...(combo
            ? {
                type:
                  kind === 'column' || kind === 'bar'
                    ? 'column'
                    : kind === 'area'
                      ? 'area'
                      : 'line',
              }
            : {}),
          ...(secondary ? { axis: 'secondary' } : {}),
          ...(s.color !== undefined ? { color: s.color } : {}),
        },
      ]);
    }
  }
  // Stable: a group's series keep their order; across groups, `c:idx` orders them (a combo's).
  ordered.sort((a, b) => a[0] - b[0]);
  for (const [, sr] of ordered) series.push(sr);
  for (const d of dropped) report.push(`${where}: ${d} was not imported.`);
  if (series.length === 0) {
    report.push(`${where}: no series to draw.`);
    return undefined;
  }
  // Gridlines: a value axis has them unless it says not; a category axis has none unless it says so.
  const axisOf = (a: RawAxis | undefined): ChartAxis | undefined => {
    if (a === undefined) return undefined;
    const valueLike = a.element === 'valAx';
    const out: ChartAxis = {
      ...(a.title !== undefined ? { title: a.title } : {}),
      ...(a.min !== undefined ? { min: a.min } : {}),
      ...(a.max !== undefined ? { max: a.max } : {}),
      ...(a.format !== undefined ? { format: a.format } : {}),
      ...(a.log ? { log: true } : {}),
      ...(valueLike && !a.gridlines ? { gridlines: false } : {}),
      ...(!valueLike && a.gridlines ? { gridlines: true } : {}),
    };
    return Object.keys(out).length === 0 ? undefined : out;
  };
  const x = axisOf(catAxis);
  const y = axisOf(type === 'scatter' ? (valAxes[1] ?? primaryVal) : primaryVal);
  const y2 = axisOf(secondaryVal);
  const axes =
    x !== undefined || y !== undefined || y2 !== undefined
      ? {
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          ...(y2 !== undefined ? { y2 } : {}),
        }
      : undefined;
  const byRows =
    series.length > 1 &&
    series.every((s) => {
      const r = /\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(s.values);
      return r !== null && r[2] === r[4] && r[1] !== r[3];
    });
  return {
    id,
    type,
    ...(variant !== undefined ? { variant } : {}),
    anchor,
    data: {
      series,
      by: byRows ? 'rows' : 'columns',
      headers: {
        row: series.some((s) => s.name !== undefined),
        column: series.some((s) => s.categories !== undefined),
      },
      blanks:
        raw.dispBlanksAs === 'zero' ? 'zero' : raw.dispBlanksAs === 'span' ? 'connect' : 'gap',
    },
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    legend: raw.legend !== undefined ? (LEGEND[raw.legend] ?? 'bottom') : 'none',
    ...(axes !== undefined ? { axes } : {}),
    ...(groups.some((g) => g.showVal) ? { labels: true } : {}),
  };
}

/** The anchors and chart parts of a drawing, in document order. */
export interface DrawingItem {
  anchor: ChartAnchor;
  /** The `r:id` of the `c:chart`, or `undefined` for a shape or picture. */
  chart?: string;
  /** A `cx:chart` (Excel 2016's chart types), with its `r:id`. */
  chartEx?: string;
  picture: boolean;
}

export function parseDrawing(xml: string): DrawingItem[] {
  const items: DrawingItem[] = [];
  let anchorKind: 'twoCellAnchor' | 'oneCellAnchor' | 'absoluteAnchor' | undefined;
  let from: CellOffset | undefined;
  let to: CellOffset | undefined;
  let pos: { x: number; y: number } | undefined;
  let ext: { width: number; height: number } | undefined;
  let chart: string | undefined;
  let chartEx: string | undefined;
  let picture = false;
  let marker: 'from' | 'to' | undefined;
  let offset: { col: number; colOff: number; row: number; rowOff: number } = {
    col: 0,
    colOff: 0,
    row: 0,
    rowOff: 0,
  };
  let field: 'col' | 'colOff' | 'row' | 'rowOff' | undefined;
  let value = '';
  const flush = () => {
    if (anchorKind === undefined) return;
    let anchor: ChartAnchor | undefined;
    if (anchorKind === 'twoCellAnchor' && from !== undefined && to !== undefined)
      anchor = { kind: 'cells', from, to };
    else if (anchorKind === 'oneCellAnchor' && from !== undefined && ext !== undefined)
      anchor = {
        kind: 'cell',
        from,
        width: Math.max(1, ext.width),
        height: Math.max(1, ext.height),
      };
    else if (anchorKind === 'absoluteAnchor' && pos !== undefined && ext !== undefined)
      anchor = {
        kind: 'absolute',
        ...pos,
        width: Math.max(1, ext.width),
        height: Math.max(1, ext.height),
      };
    if (anchor !== undefined) items.push({ anchor, chart, chartEx, picture });
    anchorKind = undefined;
    from = to = pos = ext = chart = chartEx = undefined;
    picture = false;
  };
  scan(xml, {
    open(name, a) {
      if (name === 'twoCellAnchor' || name === 'oneCellAnchor' || name === 'absoluteAnchor') {
        anchorKind = name;
      } else if (name === 'from' || name === 'to') {
        marker = name;
        offset = { col: 0, colOff: 0, row: 0, rowOff: 0 };
      } else if (name === 'col' || name === 'colOff' || name === 'row' || name === 'rowOff') {
        field = name;
        value = '';
      } else if (name === 'pos') pos = { x: emuToPx(a.x), y: emuToPx(a.y) };
      else if (
        name === 'ext' &&
        anchorKind !== undefined &&
        a.cx !== undefined &&
        ext === undefined
      )
        ext = { width: emuToPx(a.cx), height: emuToPx(a.cy) };
      else if (name === 'chart') {
        if (chart === undefined) chart = a.id;
        if (a.id === undefined) chart = chart ?? 'missing';
      } else if (name === 'pic') picture = true;
    },
    text(t) {
      if (field !== undefined) value += t;
    },
    close(name) {
      if (name === 'col' || name === 'colOff' || name === 'row' || name === 'rowOff') {
        offset[name] = Number(value.trim());
        field = undefined;
      } else if (name === 'from' || name === 'to') {
        const cell: CellOffset = {
          row: offset.row,
          col: offset.col,
          dx: emuToPx(String(offset.colOff)),
          dy: emuToPx(String(offset.rowOff)),
        };
        if (marker === 'from') from = cell;
        else to = cell;
        marker = undefined;
      } else if (name === 'twoCellAnchor' || name === 'oneCellAnchor' || name === 'absoluteAnchor')
        flush();
    },
  });
  // A `cx:chart` is written in an `mc:AlternateContent`; its `r:id` is on a `cx:chart` element too,
  // which the scanner reports as `chart`: tell the two apart by the relationship type later.
  return items;
}

/** The parts of a relationship file: id → { target, type }. */
export function parseRels(xml: string | undefined): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (xml === undefined) return out;
  scan(xml, {
    open(name, a) {
      if (name === 'Relationship' && a.Id !== undefined && a.Target !== undefined)
        out.set(a.Id, { target: a.Target, type: a.Type ?? '' });
    },
  });
  return out;
}

/** A target relative to a part's directory, as a package path. */
export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = partPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') dir.pop();
    else if (seg !== '.') dir.push(seg);
  }
  return dir.join('/');
}

/**
 * Read the charts of one sheet: its drawing part's anchors, each chart part
 * mapped to a `ChartSpec`, the rest reported. `files` is the unzipped
 * package; `sheetPath` the sheet's part; `drawingId` the `r:id` of its
 * `<drawing>`.
 */
export function readSheetCharts(
  text: (path: string) => string | undefined,
  sheetPath: string,
  drawingId: string,
  sheetName: string,
  report: string[],
): Record<string, ChartSpec> {
  const charts: Record<string, ChartSpec> = {};
  const dir = sheetPath.split('/').slice(0, -1).join('/');
  const base = sheetPath.split('/').pop()!;
  const sheetRels = parseRels(text(`${dir}/_rels/${base}.rels`));
  const drawingRel = sheetRels.get(drawingId);
  if (drawingRel === undefined) {
    report.push(`${sheetName}: the drawing part is missing.`);
    return charts;
  }
  const drawingPath = resolveTarget(sheetPath, drawingRel.target);
  const drawingXml = text(drawingPath);
  if (drawingXml === undefined) {
    report.push(`${sheetName}: the drawing part ${drawingPath} is missing.`);
    return charts;
  }
  const ddir = drawingPath.split('/').slice(0, -1).join('/');
  const dbase = drawingPath.split('/').pop()!;
  const drawingRels = parseRels(text(`${ddir}/_rels/${dbase}.rels`));
  let n = 0;
  for (const item of parseDrawing(drawingXml)) {
    if (item.chart === undefined) continue;
    const rel = drawingRels.get(item.chart);
    if (rel === undefined) {
      report.push(`${sheetName}: a chart's part is missing (${item.chart}).`);
      continue;
    }
    n += 1;
    const id = `chart${n}`;
    if (/chartEx/i.test(rel.type) || /chartEx/.test(rel.target)) {
      const xml = text(resolveTarget(drawingPath, rel.target)) ?? '';
      const kind = /<cx:layoutId val="([^"]+)"/.exec(xml)?.[1] ?? 'unknown';
      report.push(`${sheetName}: chart '${id}': an Excel 2016 chart (${kind}) was not imported.`);
      continue;
    }
    const xml = text(resolveTarget(drawingPath, rel.target));
    if (xml === undefined) {
      report.push(`${sheetName}: chart '${id}': its part ${rel.target} is missing.`);
      continue;
    }
    const spec = chartFromPart(parseChartPart(xml), id, item.anchor, sheetName, report);
    if (spec !== undefined) charts[id] = spec;
  }
  return charts;
}

// ------------------------------------------------------------------ writing

const offsetXml = (tag: 'from' | 'to', c: CellOffset) =>
  `<xdr:${tag}><xdr:col>${c.col}</xdr:col><xdr:colOff>${pxToEmu(c.dx)}</xdr:colOff><xdr:row>${c.row}</xdr:row><xdr:rowOff>${pxToEmu(c.dy)}</xdr:rowOff></xdr:${tag}>`;

function anchorXml(anchor: ChartAnchor, inner: string): string {
  switch (anchor.kind) {
    case 'cells':
      return `<xdr:twoCellAnchor editAs="oneCell">${offsetXml('from', anchor.from)}${offsetXml('to', anchor.to)}${inner}<xdr:clientData/></xdr:twoCellAnchor>`;
    case 'cell':
      return `<xdr:oneCellAnchor>${offsetXml('from', anchor.from)}<xdr:ext cx="${pxToEmu(anchor.width)}" cy="${pxToEmu(anchor.height)}"/>${inner}<xdr:clientData/></xdr:oneCellAnchor>`;
    case 'absolute':
      return `<xdr:absoluteAnchor><xdr:pos x="${pxToEmu(anchor.x)}" y="${pxToEmu(anchor.y)}"/><xdr:ext cx="${pxToEmu(anchor.width)}" cy="${pxToEmu(anchor.height)}"/>${inner}<xdr:clientData/></xdr:absoluteAnchor>`;
  }
}

/** The `xl/drawings/drawingN.xml` of a sheet's charts, each chart as `rId<i>` of the drawing's rels. */
export function drawingXml(charts: readonly ChartSpec[]): string {
  const frames = charts.map((c, i) => {
    const inner =
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${escape(c.title ?? c.id)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" xmlns:r="${REL_NS}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame>`;
    return anchorXml(c.anchor, inner);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="${DML_NS}">${frames.join('')}</xdr:wsDr>`;
}

/** The chart's values, cached in the part as Excel and LibreOffice expect. */
function cache(model: CellsModel, sheet: string, ref: Ref | undefined, text: boolean): string {
  if (ref === undefined) return '';
  const r = refZone(model.workbook, sheet, ref);
  if (r === undefined) return `<c:f>${escape(ref)}</c:f>`;
  const pts: string[] = [];
  let i = 0;
  for (let row = r.zone.top; row <= r.zone.bottom; row += 1)
    for (let col = r.zone.left; col <= r.zone.right; col += 1) {
      const v: CellValue = model.value(r.sheet, row, col);
      if (text) {
        if (v !== null && typeof v !== 'object')
          pts.push(
            `<c:pt idx="${i}"><c:v>${escape(typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))}</c:v></c:pt>`,
          );
      } else if (typeof v === 'number') pts.push(`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`);
      i += 1;
    }
  const tag = text ? 'strCache' : 'numCache';
  return `<c:f>${escape(ref)}</c:f><c:${tag}>${text ? '' : '<c:formatCode>General</c:formatCode>'}<c:ptCount val="${i}"/>${pts.join('')}</c:${tag}>`;
}

function refOrText(model: CellsModel, sheet: string, name: Ref | string | undefined): string {
  if (name === undefined) return '';
  const r = refZone(model.workbook, sheet, name);
  if (r === undefined && !/^#REF!$/.test(name) && !/!/.test(name))
    return `<c:tx><c:v>${escape(name)}</c:v></c:tx>`;
  return `<c:tx><c:strRef>${cache(model, sheet, name, true)}</c:strRef></c:tx>`;
}

/** Whether the categories' cells are text (a `c:strRef`) or numbers (a `c:numRef`). */
function categoriesAreText(model: CellsModel, sheet: string, ref: Ref): boolean {
  const r = refZone(model.workbook, sheet, ref);
  if (r === undefined) return true;
  for (let row = r.zone.top; row <= r.zone.bottom; row += 1)
    for (let col = r.zone.left; col <= r.zone.right; col += 1)
      if (typeof model.value(r.sheet, row, col) === 'string') return true;
  return false;
}

const spPr = (color: string | undefined, line: boolean) =>
  color === undefined
    ? ''
    : line
      ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${color.slice(1).toUpperCase()}"/></a:solidFill></a:ln></c:spPr>`
      : `<c:spPr><a:solidFill><a:srgbClr val="${color.slice(1).toUpperCase()}"/></a:solidFill></c:spPr>`;

function seriesXml(
  model: CellsModel,
  sheet: string,
  s: ChartSeries,
  i: number,
  kind: 'bar' | 'line' | 'area' | 'pie' | 'scatter',
  smooth: boolean,
): string {
  const cats =
    s.categories !== undefined
      ? `<c:cat>${categoriesAreText(model, sheet, s.categories) ? `<c:strRef>${cache(model, sheet, s.categories, true)}</c:strRef>` : `<c:numRef>${cache(model, sheet, s.categories, false)}</c:numRef>`}</c:cat>`
      : '';
  const head = `<c:idx val="${i}"/><c:order val="${i}"/>${refOrText(model, sheet, s.name)}${spPr(s.color, kind === 'line' || kind === 'scatter')}`;
  if (kind === 'scatter') {
    const x =
      s.x !== undefined
        ? `<c:xVal><c:numRef>${cache(model, sheet, s.x, false)}</c:numRef></c:xVal>`
        : '';
    return `<c:ser>${head}<c:marker><c:symbol val="circle"/></c:marker>${x}<c:yVal><c:numRef>${cache(model, sheet, s.values, false)}</c:numRef></c:yVal><c:smooth val="0"/></c:ser>`;
  }
  const marker = kind === 'line' ? '<c:marker><c:symbol val="none"/></c:marker>' : '';
  const tail = kind === 'line' ? `<c:smooth val="${smooth ? 1 : 0}"/>` : '';
  return `<c:ser>${head}${marker}${cats}<c:val><c:numRef>${cache(model, sheet, s.values, false)}</c:numRef></c:val>${tail}</c:ser>`;
}

function axisTitle(title: string | undefined): string {
  if (title === undefined) return '';
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${escape(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function catAxXml(
  id: string,
  crossId: string,
  axis: ChartAxis | undefined,
  pos: 'b' | 'l',
  deleted = false,
): string {
  return (
    `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${deleted ? 1 : 0}"/><c:axPos val="${pos}"/>` +
    (axis?.gridlines ? '<c:majorGridlines/>' : '') +
    axisTitle(axis?.title) +
    (axis?.format !== undefined
      ? `<c:numFmt formatCode="${escape(axis.format)}" sourceLinked="0"/>`
      : '') +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`
  );
}

function valAxXml(
  id: string,
  crossId: string,
  axis: ChartAxis | undefined,
  pos: 'l' | 'r' | 'b',
  secondary = false,
  gridlinesDefault = true,
): string {
  const scaling =
    (axis?.log ? '<c:logBase val="10"/>' : '') +
    '<c:orientation val="minMax"/>' +
    (axis?.max !== undefined ? `<c:max val="${axis.max}"/>` : '') +
    (axis?.min !== undefined ? `<c:min val="${axis.min}"/>` : '');
  return (
    `<c:valAx><c:axId val="${id}"/><c:scaling>${scaling}</c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>` +
    ((axis?.gridlines ?? gridlinesDefault) ? '<c:majorGridlines/>' : '') +
    axisTitle(axis?.title) +
    (axis?.format !== undefined
      ? `<c:numFmt formatCode="${escape(axis.format)}" sourceLinked="0"/>`
      : '<c:numFmt formatCode="General" sourceLinked="1"/>') +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${crossId}"/><c:crosses val="${secondary ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`
  );
}

/** The `xl/charts/chartN.xml` of one chart. */
export function chartPartXml(model: CellsModel, sheet: string, spec: ChartSpec): string {
  const title =
    spec.title !== undefined
      ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${escape(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
      : '<c:autoTitleDeleted val="1"/>';
  const grouping =
    spec.variant === 'stacked'
      ? 'stacked'
      : spec.variant === 'percent'
        ? 'percentStacked'
        : 'clustered';
  const dLbls = spec.labels
    ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'
    : '';
  const all = spec.data.series;
  const ser = (list: readonly ChartSeries[], kind: 'bar' | 'line' | 'area' | 'pie' | 'scatter') =>
    list
      .map((s) => seriesXml(model, sheet, s, all.indexOf(s), kind, spec.variant === 'smooth'))
      .join('');
  let plot = '';
  let axes = '';
  const A1 = '500000001';
  const A2 = '500000002';
  const A3 = '500000003';
  const A4 = '500000004';
  switch (spec.type) {
    case 'pie':
      plot =
        spec.variant === 'doughnut'
          ? `<c:doughnutChart><c:varyColors val="1"/>${ser(all, 'pie')}${dLbls}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`
          : `<c:pieChart><c:varyColors val="1"/>${ser(all, 'pie')}${dLbls}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'scatter':
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser(all, 'scatter')}${dLbls}<c:axId val="${A1}"/><c:axId val="${A2}"/></c:scatterChart>`;
      axes = valAxXml(A1, A2, spec.axes?.x, 'b') + valAxXml(A2, A1, spec.axes?.y, 'l');
      break;
    case 'line':
      plot = `<c:lineChart><c:grouping val="${grouping === 'clustered' ? 'standard' : grouping}"/><c:varyColors val="0"/>${ser(all, 'line')}${dLbls}<c:marker val="1"/><c:axId val="${A1}"/><c:axId val="${A2}"/></c:lineChart>`;
      axes = catAxXml(A1, A2, spec.axes?.x, 'b') + valAxXml(A2, A1, spec.axes?.y, 'l');
      break;
    case 'area':
      plot = `<c:areaChart><c:grouping val="${grouping === 'clustered' ? 'standard' : grouping}"/><c:varyColors val="0"/>${ser(all, 'area')}${dLbls}<c:axId val="${A1}"/><c:axId val="${A2}"/></c:areaChart>`;
      axes = catAxXml(A1, A2, spec.axes?.x, 'b') + valAxXml(A2, A1, spec.axes?.y, 'l');
      break;
    case 'combo': {
      const primary = all.filter((s) => s.axis !== 'secondary');
      const secondary = all.filter((s) => s.axis === 'secondary');
      const groupsOf = (list: readonly ChartSeries[], ids: [string, string]) => {
        const parts: string[] = [];
        const kinds: ('column' | 'line' | 'area')[] = ['column', 'line', 'area'];
        for (const kind of kinds) {
          const of = list.filter((s) => (s.type ?? 'column') === kind);
          if (of.length === 0) continue;
          const body = ser(of, kind === 'column' ? 'bar' : kind);
          const ax = `<c:axId val="${ids[0]}"/><c:axId val="${ids[1]}"/>`;
          if (kind === 'column')
            parts.push(
              `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${body}${dLbls}<c:gapWidth val="150"/>${ax}</c:barChart>`,
            );
          else if (kind === 'line')
            parts.push(
              `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${body}${dLbls}<c:marker val="1"/>${ax}</c:lineChart>`,
            );
          else
            parts.push(
              `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${body}${dLbls}${ax}</c:areaChart>`,
            );
        }
        return parts.join('');
      };
      plot =
        groupsOf(primary, [A1, A2]) + (secondary.length > 0 ? groupsOf(secondary, [A3, A4]) : '');
      axes = catAxXml(A1, A2, spec.axes?.x, 'b') + valAxXml(A2, A1, spec.axes?.y, 'l');
      if (secondary.length > 0)
        axes += catAxXml(A3, A4, undefined, 'b', true) + valAxXml(A4, A3, spec.axes?.y2, 'r', true);
      break;
    }
    default: {
      // column, bar
      const dir = spec.type === 'bar' ? 'bar' : 'col';
      plot = `<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${ser(all, 'bar')}${dLbls}<c:gapWidth val="150"/>${grouping !== 'clustered' ? '<c:overlap val="100"/>' : ''}<c:axId val="${A1}"/><c:axId val="${A2}"/></c:barChart>`;
      axes =
        catAxXml(A1, A2, spec.axes?.x, dir === 'bar' ? 'l' : 'b') +
        valAxXml(A2, A1, spec.axes?.y, dir === 'bar' ? 'b' : 'l');
    }
  }
  const legend =
    spec.legend === 'none'
      ? ''
      : `<c:legend><c:legendPos val="${spec.legend[0]}"/><c:overlay val="0"/></c:legend>`;
  const blanks =
    spec.data.blanks === 'zero' ? 'zero' : spec.data.blanks === 'connect' ? 'span' : 'gap';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="${DML_NS}" xmlns:r="${REL_NS}">` +
    '<c:roundedCorners val="0"/>' +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="${blanks}"/></c:chart>` +
    '</c:chartSpace>'
  );
}
