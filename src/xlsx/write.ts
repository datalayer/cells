/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The XLSX writer: a model's sheets as SpreadsheetML parts, zipped with
 * fflate. What the reader reads, the writer writes: values (strings shared),
 * formulas with the value they show, styles (fonts, fills, borders,
 * alignment, wrap, number formats, built-in ids where there is one),
 * merges, column widths, row heights, hidden rows and columns, frozen panes,
 * several sheets.
 *
 * @module xlsx/write
 */

import { strToU8, zipSync } from 'fflate';
import { CHART_CONTENT_TYPE, chartPartXml, DRAWING_CONTENT_TYPE, drawingXml } from './charts.js';
import type { CellsModel } from '../core/model.js';
import type { CellsWorkbook } from '../core/format.js';
import type { BorderSide, Style } from '../core/styles.js';
import { type CellValue, isCellError } from '../core/values.js';
import { columnLetters } from '../core/zone.js';
import { builtinId } from './formats.js';
import { escape } from './xml.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const DEFAULT_COL_PX = 100;
const DEFAULT_ROW_PX = 24;

/** Pixels to the width SpreadsheetML counts in characters of the default font (7 px each, plus 5). */
const widthChars = (px: number) => Math.round(((px - 5) / 7) * 256) / 256;
/** Pixels to points. */
const heightPoints = (px: number) => Math.round(px * 0.75 * 100) / 100;

const argb = (color: string) => `FF${color.replace('#', '').toUpperCase()}`;

/** The styles part, and a cell format (`xf`) index per style index of the model. */
function stylesPart(styles: readonly Style[]): { xml: string; xfOf: number[] } {
  const fonts: string[] = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts: string[] = [];
  const customIds = new Map<string, number>();
  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = (list: string[], xml: string) => {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  };
  const side = (name: string, b: BorderSide | undefined) =>
    b === undefined
      ? `<${name}/>`
      : `<${name} style="${b.style}"><color rgb="${argb(b.color)}"/></${name}>`;
  const xfOf = styles.map((s, i) => {
    if (i === 0) return 0;
    const font =
      '<font>' +
      (s.bold ? '<b/>' : '') +
      (s.italic ? '<i/>' : '') +
      (s.strike ? '<strike/>' : '') +
      (s.underline ? '<u/>' : '') +
      `<sz val="${s.size ?? 11}"/>` +
      (s.color ? `<color rgb="${argb(s.color)}"/>` : '') +
      `<name val="${escape(s.font ?? 'Calibri')}"/></font>`;
    const fontId = index(fonts, font);
    const fillId = s.fill
      ? index(
          fills,
          `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`,
        )
      : 0;
    const b = s.borders;
    const borderId = b
      ? index(
          borders,
          `<border>${side('left', b.left)}${side('right', b.right)}${side('top', b.top)}${side('bottom', b.bottom)}<diagonal/></border>`,
        )
      : 0;
    let numFmtId = 0;
    if (s.format !== undefined && s.format !== 'General') {
      const builtin = builtinId(s.format);
      if (builtin !== undefined) numFmtId = builtin;
      else {
        let id = customIds.get(s.format);
        if (id === undefined) {
          id = 164 + customIds.size;
          customIds.set(s.format, id);
          numFmts.push(`<numFmt numFmtId="${id}" formatCode="${escape(s.format)}"/>`);
        }
        numFmtId = id;
      }
    }
    const align =
      s.align || s.valign || s.wrap
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''}${
            s.valign ? ` vertical="${s.valign === 'middle' ? 'center' : s.valign}"` : ''
          }${s.wrap ? ' wrapText="1"' : ''}/>`
        : '';
    const xf =
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
      `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}` +
      (align ? ` applyAlignment="1">${align}</xf>` : '/>');
    return index(xfs, xf);
  });
  const xml =
    `${XML}<styleSheet xmlns="${NS}">` +
    (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="${borders.length}">${borders.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
  return { xml, xfOf };
}

/** Where the code cells' sources go in the package. */
export const CODE_PART = 'customXml/cells-code.xml';

/** The custom XML part holding every code cell's source and how it runs, by sheet name and cell; `undefined` with none. */
export function codePartXml(json: CellsWorkbook): string | undefined {
  const sheets = json.sheets.filter((s) => s.code !== undefined && Object.keys(s.code).length > 0);
  if (sheets.length === 0) return undefined;
  const cells = sheets.flatMap((s) =>
    Object.entries(s.code!).map(
      ([ref, c]) =>
        `<cell sheet="${escape(s.name)}" ref="${ref}" language="${c.language}" run="${c.run}"` +
        (c.frame === null
          ? ' frame="none"'
          : c.frame !== undefined
            ? ` frameWidth="${c.frame.width}" frameHeight="${c.frame.height}"` +
              (c.frame.dx !== undefined ? ` frameDx="${c.frame.dx}"` : '') +
              (c.frame.dy !== undefined ? ` frameDy="${c.frame.dy}"` : '')
            : '') +
        (c.executionCount !== undefined ? ` executionCount="${c.executionCount}"` : '') +
        (c.lastRun !== undefined ? ` lastRun="${escape(c.lastRun)}"` : '') +
        `><source>${escape(c.source)}</source></cell>`,
    ),
  );
  return `${XML}<cellsCode xmlns="https://datalayer.io/cells/code" version="1">${cells.join('')}</cellsCode>`;
}

/** Write a model's workbook as XLSX bytes. */
export function writeXlsx(model: CellsModel): Uint8Array {
  const chartParts: string[] = []; // the chart parts' numbers, across sheets
  const extraTypes: string[] = [];
  const json = model.toJSON();
  const { xml: stylesXml, xfOf } = stylesPart(json.styles ?? [{}]);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const shared = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  const files: Record<string, Uint8Array> = {};
  // Code cells (§3.13): XLSX has no place for code, so the sources go into a custom XML part, by
  // sheet and cell; the result is the cell's cached value above; the outputs are not written.
  const code = codePartXml(json);
  json.sheets.forEach((sheet, n) => {
    const s = model.sheet(sheet.id);
    const parts: string[] = [`${XML}<worksheet xmlns="${NS}" xmlns:r="${REL}">`];
    const frozen = sheet.frozen;
    parts.push(
      '<sheetViews><sheetView workbookViewId="0"' + (n === 0 ? ' tabSelected="1"' : '') + '>',
    );
    if (frozen && (frozen.rows > 0 || frozen.cols > 0)) {
      const pane =
        frozen.rows > 0 && frozen.cols > 0
          ? 'bottomRight'
          : frozen.rows > 0
            ? 'bottomLeft'
            : 'topRight';
      parts.push(
        `<pane${frozen.cols > 0 ? ` xSplit="${frozen.cols}"` : ''}${frozen.rows > 0 ? ` ySplit="${frozen.rows}"` : ''}` +
          ` topLeftCell="${columnLetters(frozen.cols)}${frozen.rows + 1}" activePane="${pane}" state="frozen"/>`,
      );
    }
    parts.push('</sheetView></sheetViews>');
    parts.push(
      `<sheetFormatPr defaultRowHeight="${heightPoints(DEFAULT_ROW_PX)}" customHeight="1"/>`,
    );
    // Columns with a width or hidden.
    const colIndexes = new Set<number>([
      ...Object.keys(sheet.sizes?.cols ?? {}).map(Number),
      ...(sheet.hidden?.cols ?? []),
    ]);
    if (colIndexes.size > 0) {
      parts.push('<cols>');
      for (const c of [...colIndexes].sort((a, b) => a - b)) {
        const px = s.cols.sizeOf(c) || DEFAULT_COL_PX;
        parts.push(
          `<col min="${c + 1}" max="${c + 1}" width="${widthChars(px)}" customWidth="1"${s.cols.isHidden(c) ? ' hidden="1"' : ''}/>`,
        );
      }
      parts.push('</cols>');
    }
    parts.push('<sheetData>');
    const rowSizes = sheet.sizes?.rows ?? {};
    const hiddenRows = new Set(sheet.hidden?.rows ?? []);
    const rowIndexes = new Set<number>([
      ...Object.keys(sheet.rows).map(Number),
      ...Object.keys(rowSizes).map(Number),
      ...hiddenRows,
    ]);
    for (const r of [...rowIndexes].sort((a, b) => a - b)) {
      const size = rowSizes[String(r)];
      const attrs =
        `r="${r + 1}"` +
        (size !== undefined ? ` ht="${heightPoints(size)}" customHeight="1"` : '') +
        (hiddenRows.has(r) ? ' hidden="1"' : '');
      const cells = sheet.rows[String(r)]?.cells ?? {};
      const cols = Object.keys(cells)
        .map(Number)
        .sort((a, b) => a - b);
      if (cols.length === 0) {
        parts.push(`<row ${attrs}/>`);
        continue;
      }
      parts.push(`<row ${attrs}>`);
      for (const c of cols) {
        const cell = cells[String(c)];
        const ref = `${columnLetters(c)}${r + 1}`;
        const style = cell.s ? xfOf[cell.s] : 0;
        const sAttr = style ? ` s="${style}"` : '';
        // A formula carries the value it shows, so other applications show it before recalculating.
        const value: CellValue = model.value(sheet.id, r, c);
        const f = cell.f !== undefined ? `<f>${escape(cell.f)}</f>` : '';
        if (value === null)
          parts.push(f ? `<c r="${ref}"${sAttr}>${f}</c>` : `<c r="${ref}"${sAttr}/>`);
        else if (typeof value === 'number')
          parts.push(`<c r="${ref}"${sAttr}>${f}<v>${value}</v></c>`);
        else if (typeof value === 'boolean')
          parts.push(`<c r="${ref}"${sAttr} t="b">${f}<v>${value ? 1 : 0}</v></c>`);
        else if (isCellError(value))
          parts.push(`<c r="${ref}"${sAttr} t="e">${f}<v>${escape(value.error)}</v></c>`);
        else if (f) parts.push(`<c r="${ref}"${sAttr} t="str">${f}<v>${escape(value)}</v></c>`);
        else parts.push(`<c r="${ref}"${sAttr} t="s"><v>${shared(value)}</v></c>`);
      }
      parts.push('</row>');
    }
    parts.push('</sheetData>');
    const merges = sheet.merges ?? [];
    if (merges.length > 0) {
      parts.push(`<mergeCells count="${merges.length}">`);
      for (const z of merges)
        parts.push(
          `<mergeCell ref="${columnLetters(z.left)}${z.top + 1}:${columnLetters(z.right)}${z.bottom + 1}"/>`,
        );
      parts.push('</mergeCells>');
    }
    const charts = [...s.charts.values()];
    if (charts.length > 0) {
      parts.push('<drawing r:id="rId1"/>');
      const d = n + 1;
      files[`xl/worksheets/_rels/sheet${n + 1}.xml.rels`] = strToU8(
        `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${d}.xml"/></Relationships>`,
      );
      files[`xl/drawings/drawing${d}.xml`] = strToU8(drawingXml(charts));
      extraTypes.push(
        `<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="${DRAWING_CONTENT_TYPE}"/>`,
      );
      const rels = charts.map((c, i) => {
        const m = chartParts.length + 1;
        chartParts.push(`chart${m}`);
        files[`xl/charts/chart${m}.xml`] = strToU8(chartPartXml(model, sheet.id, c));
        extraTypes.push(
          `<Override PartName="/xl/charts/chart${m}.xml" ContentType="${CHART_CONTENT_TYPE}"/>`,
        );
        return `<Relationship Id="rId${i + 1}" Type="${REL}/chart" Target="../charts/chart${m}.xml"/>`;
      });
      files[`xl/drawings/_rels/drawing${d}.xml.rels`] = strToU8(
        `${XML}<Relationships xmlns="${PKG_REL}">${rels.join('')}</Relationships>`,
      );
    }
    parts.push('</worksheet>');
    files[`xl/worksheets/sheet${n + 1}.xml`] = strToU8(parts.join(''));
  });
  const sheetList = json.sheets
    .map((s, n) => `<sheet name="${escape(s.name)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`)
    .join('');
  const sheetRels = json.sheets
    .map(
      (_, n) =>
        `<Relationship Id="rId${n + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`,
    )
    .join('');
  const k = json.sheets.length;
  files['[Content_Types].xml'] = strToU8(
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      json.sheets
        .map(
          (_, n) =>
            `<Override PartName="/xl/worksheets/sheet${n + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      extraTypes.join('') +
      '</Types>',
  );
  files['_rels/.rels'] = strToU8(
    `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${sheetList}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `${XML}<Relationships xmlns="${PKG_REL}">${sheetRels}` +
      `<Relationship Id="rId${k + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${k + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      (code === undefined
        ? ''
        : `<Relationship Id="rId${k + 3}" Type="${REL}/customXml" Target="../customXml/cells-code.xml"/>`) +
      '</Relationships>',
  );
  if (code !== undefined) files[CODE_PART] = strToU8(code);
  files['xl/styles.xml'] = strToU8(stylesXml);
  files['xl/sharedStrings.xml'] = strToU8(
    `${XML}<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings
        .map(
          (t) =>
            `<si><t${t !== t.trim() || t.includes('\n') ? ' xml:space="preserve"' : ''}>${escape(t)}</t></si>`,
        )
        .join('') +
      '</sst>',
  );
  return zipSync(files, { level: 6 });
}
