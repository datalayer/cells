/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@acme/everything`: a third-party Reactor plugin, written as any host
 * would write one, that contributes to every `datalayer.cells.*` point. It
 * is what the plugin guide (docs/plugins.md) walks through, point by point,
 * and what the examples' *A Reactor plugin* page runs on a grid built from
 * `CellsCorePlugin` and this plugin alone.
 *
 * @module examples/plugin/acme
 */

import { contribution, definePlugin, type ReactorCommand } from '@datalayer/reactor';
import {
  type CellsCell,
  CellsCellTypes,
  CellsChartOptions,
  CellsChartRenderer,
  type ChartRendererProps,
  CellsChartTypes,
  CellsClipboard,
  CellsCollabProvider,
  CellsCommands,
  CellsDataSources,
  CellsEditGate,
  CellsExporters,
  CellsFillRules,
  CellsFunctions,
  CellsImporters,
  CellsKernels,
  CellsMenuItems,
  CellsPatchOps,
  CellsRenderLayers,
  CellsToolbarItems,
  type CellsCommandArgument,
  programParts,
  RESULT_MIME,
  type CellsModel,
  type CellsWorkbook,
  type CellType,
  type CellValue,
  cellsPatch,
  type ChartOption,
  type CommandHandler,
  type Patch,
  type PatchOp,
  parseInput,
  refuse,
  toText,
  type Workbook,
  type Zone,
  zoneContains,
  zoneToA1,
} from '@datalayer/cells';
import { RadarChart } from 'echarts/charts';
import type { LoroDoc } from 'loro-crdt';
import { createElement } from 'react';

export const ACME_PLUGIN = '@acme/everything';

// ----------------------------------------------------------------- notes: a patch op and a command

/** Notes on cells, kept by the plugin beside the workbook (the workbook's own data knows nothing of them). */
const notesOf = new WeakMap<Workbook, Map<string, string>>();

/** The notes of a workbook, `"sheet:row:col"` → text. */
export function notes(workbook: Workbook): Map<string, string> {
  let m = notesOf.get(workbook);
  if (m === undefined) {
    m = new Map();
    notesOf.set(workbook, m);
  }
  return m;
}

export const noteKey = (sheet: string, row: number, col: number) => `${sheet}:${row}:${col}`;

export interface NotePatch {
  readonly op: 'acme.note';
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly before: string | null;
  readonly after: string | null;
}

/** A patch op of the plugin's own: `apply` writes the note, `invert` swaps before and after, `example` feeds the forcing test. */
export const noteOp: PatchOp<NotePatch> = {
  op: 'acme.note',
  apply(workbook, p) {
    const m = notes(workbook);
    if (p.after === null) m.delete(noteKey(p.sheet, p.row, p.col));
    else m.set(noteKey(p.sheet, p.row, p.col), p.after);
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'acme.note',
    sheet: 's1',
    row: 0,
    col: 0,
    before: null,
    after: 'Check this',
  }),
};

export interface SetNoteCommand {
  readonly type: 'SET_NOTE';
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** `null` removes the note. */
  readonly text: string | null;
}

export const setNote: CommandHandler<SetNoteCommand> = {
  type: 'SET_NOTE',
  allow({ workbook }, c) {
    if (!workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
    if (c.text !== null && (typeof c.text !== 'string' || c.text.trim() === ''))
      return refuse('InvalidArgument', 'A note is text, or null to remove it.');
    return { ok: true };
  },
  apply({ workbook }, c) {
    const before = notes(workbook).get(noteKey(c.sheet, c.row, c.col)) ?? null;
    return [
      { op: 'acme.note', sheet: c.sheet, row: c.row, col: c.col, before, after: c.text } as Patch,
    ];
  },
};

// ----------------------------------------------------------------- a command over the cells

export interface UppercaseCommand {
  readonly type: 'UPPERCASE';
  readonly sheet: string;
  readonly zone: Zone;
}

export const uppercase: CommandHandler<UppercaseCommand> = {
  type: 'UPPERCASE',
  apply({ workbook }, c) {
    const sheet = workbook.sheet(c.sheet);
    const contents: [number, number, { value: CellValue; formula?: string; style: number }][] = [];
    for (const [row, col, content] of sheet.cells.entries(c.zone)) {
      if (typeof content.value === 'string' && content.formula === undefined)
        contents.push([row, col, { ...content, value: content.value.toUpperCase() }]);
    }
    return contents.length === 0 ? [] : [cellsPatch(sheet, c.zone, contents)];
  },
};

// ----------------------------------------------------------------- functions

const shout = {
  name: 'SHOUT',
  args: [{ name: 'text', type: 'scalar' as const }],
  returns: 'string' as const,
  category: 'text' as const,
  compute: ([text]: readonly unknown[]) => toText(text as CellValue).toUpperCase(),
  description: 'The text in capitals.',
  examples: ['=SHOUT("hello") → HELLO'],
};

const echo = {
  name: 'ECHO',
  args: [{ name: 'text', type: 'scalar' as const }],
  returns: 'string' as const,
  category: 'text' as const,
  async: true,
  // As a function fetching from a server would: #BUSY! until it answers.
  compute: ([text]: readonly unknown[]) =>
    new Promise<CellValue>((resolve) =>
      setTimeout(() => resolve(`${toText(text as CellValue)}…${toText(text as CellValue)}`), 600),
    ),
  description: 'The text, twice, after a while.',
  examples: ['=ECHO("hey") → hey…hey'],
};

// ----------------------------------------------------------------- a cell type

/** Drawn by the plugin: the value in capitals behind a chevron, named for a screen reader. */
export const megaphone: CellType = {
  id: 'megaphone',
  render: (ctx, rect, value, style, theme) => {
    ctx.font = `bold ${(style.size ?? theme.fontSize) * rect.zoom}px ${theme.fontFamily}`;
    ctx.fillStyle = style.color ?? theme.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `» ${toText(value).toUpperCase()}`,
      rect.x + 3 * rect.zoom,
      rect.y + rect.height / 2,
    );
  },
  accessibleName: (v) => `Shouted: ${toText(v).toUpperCase()}`,
};

// ----------------------------------------------------------------- a render layer

/** A red corner on every cell that holds a note, drawn after the cells. */
export const noteMarks = {
  id: 'acme.noteMarks',
  layer: 'cells' as const,
  draw: (
    ctx: CanvasRenderingContext2D,
    view: {
      sheet: string;
      zone: Zone;
      zoom: number;
      cellRect(row: number, col: number): { x: number; y: number; width: number; height: number };
    },
    model: unknown,
  ) => {
    const m = model as CellsModel;
    for (const [key] of notes(m.workbook)) {
      const [sheet, r, c] = key.split(':');
      const row = Number(r);
      const col = Number(c);
      if (sheet !== view.sheet || !zoneContains(view.zone, { row, col })) continue;
      const rect = view.cellRect(row, col);
      const size = 6 * view.zoom;
      ctx.fillStyle = '#cf222e';
      ctx.beginPath();
      ctx.moveTo(rect.x + rect.width - 1 - size, rect.y);
      ctx.lineTo(rect.x + rect.width - 1, rect.y);
      ctx.lineTo(rect.x + rect.width - 1, rect.y + size);
      ctx.closePath();
      ctx.fill();
    }
  },
};

// ----------------------------------------------------------------- a clipboard handler

/** Notes travel with a copied zone, and land with a paste at the same offsets. */
export const notesClipboard = {
  id: 'acme.notes',
  copy: (context: { workbook: Workbook }, sheet: string, zone: Zone) => {
    const out: [number, number, string][] = [];
    for (const [key, text] of notes(context.workbook)) {
      const [s, r, c] = key.split(':');
      const row = Number(r);
      const col = Number(c);
      if (s === sheet && zoneContains(zone, { row, col }))
        out.push([row - zone.top, col - zone.left, text]);
    }
    return out.length === 0 ? undefined : out;
  },
  paste: (context: { workbook: Workbook }, sheet: string, part: unknown, target: Zone): Patch[] =>
    (part as [number, number, string][])
      .filter(([dr, dc]) => target.top + dr <= target.bottom && target.left + dc <= target.right)
      .map(([dr, dc, text]) => {
        const row = target.top + dr;
        const col = target.left + dc;
        const before = notes(context.workbook).get(noteKey(sheet, row, col)) ?? null;
        return { op: 'acme.note', sheet, row, col, before, after: text } as Patch;
      }),
};

// ----------------------------------------------------------------- a fill rule

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(n: number): string {
  let out = '';
  let rest = n;
  for (const [value, letters] of ROMAN)
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  return out;
}

export function fromRoman(text: string): number | undefined {
  if (!/^[MDCLXVI]+$/.test(text)) return undefined;
  let i = 0;
  let n = 0;
  for (const [value, letters] of ROMAN)
    while (text.startsWith(letters, i)) {
      n += value;
      i += letters.length;
    }
  return i === text.length && toRoman(n) === text ? n : undefined;
}

/** Roman numerals extend as a series: I, II, III → IV, V, … */
export const romanNumerals = {
  id: 'acme.roman',
  match: (source: readonly { value: CellValue }[]) => {
    if (source.length === 0) return undefined;
    const values = source.map((s) =>
      typeof s.value === 'string' ? fromRoman(s.value) : undefined,
    );
    if (values.some((v) => v === undefined)) return undefined;
    const numbers = values as number[];
    const step = numbers.length > 1 ? numbers[1] - numbers[0] : 1;
    if (numbers.some((v, i) => i > 0 && v - numbers[i - 1] !== step)) return undefined;
    return { first: numbers[0], last: numbers[numbers.length - 1], step };
  },
  next: (series: unknown, index: number): CellValue => {
    const s = series as { first: number; last: number; step: number };
    const n = index >= 0 ? s.last + s.step * (index + 1) : s.first + s.step * index;
    return n >= 1 && n < 4000 ? toRoman(n) : null;
  },
};

// ----------------------------------------------------------------- an importer and an exporter

/** A Markdown table (`| a | b |` rows, the `|---|` rule skipped) as a one-sheet workbook. */
export function readMarkdownTable(text: string): CellsWorkbook {
  const rows: Record<string, { cells: Record<string, CellsCell> }> = {};
  let r = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue;
    const fields = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((f) => f.trim());
    const cells: Record<string, CellsCell> = {};
    fields.forEach((field, c) => {
      if (field === '') return;
      const input = parseInput(field);
      cells[String(c)] =
        typeof input === 'object' && input !== null && 'formula' in input
          ? { f: input.formula }
          : { v: input as CellsCell['v'] };
    });
    if (Object.keys(cells).length > 0) rows[String(r)] = { cells };
    r += 1;
  }
  return { version: 1, sheets: [{ id: 'md', name: 'Table', rows }], styles: [] };
}

/** The first sheet's used rows as a Markdown table, values as shown. */
export function writeMarkdownTable(model: CellsModel): string {
  const sheet = model.sheets[0];
  let bottom = -1;
  let right = -1;
  for (const [row, col] of sheet.cells.entries()) {
    bottom = Math.max(bottom, row);
    right = Math.max(right, col);
  }
  if (bottom < 0) return '';
  const lines: string[] = [];
  for (let r = 0; r <= bottom; r += 1) {
    const fields: string[] = [];
    for (let c = 0; c <= right; c += 1) fields.push(toText(model.value(sheet.id, r, c)));
    lines.push(`| ${fields.join(' | ')} |`);
    if (r === 0) lines.push(`|${' --- |'.repeat(right + 1)}`);
  }
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- a data source

/** The first 100,000 primes, computed a page at a time. */
export const primes = {
  id: 'acme.primes',
  rowCount: 100_000,
  columns: [
    { name: 'n', type: 'number' },
    { name: 'prime', type: 'number' },
  ],
  fetch: ({ from, to }: { from: number; to: number }) =>
    new Promise<readonly (readonly CellValue[])[]>((resolve) =>
      setTimeout(() => {
        const found: number[] = [];
        for (let n = 2; found.length <= to; n += 1) {
          let prime = true;
          for (const p of found) {
            if (p * p > n) break;
            if (n % p === 0) {
              prime = false;
              break;
            }
          }
          if (prime) found.push(n);
        }
        resolve([
          Array.from({ length: to - from + 1 }, (_, i) => from + i + 1),
          found.slice(from, to + 1),
        ]);
      }, 50),
    ),
};

// ----------------------------------------------------------------- a collaboration provider

/** Rooms in this page: every document joined under a name hears the others' updates. */
const rooms = new Map<string, Set<LoroDoc>>();

/** In-memory rooms: documents of one page sharing a room name converge, with no server. */
export const localRooms = {
  id: 'acme.local',
  connect: (doc: unknown, room: string) => {
    const d = doc as LoroDoc;
    let peers = rooms.get(room);
    if (peers === undefined) {
      peers = new Set();
      rooms.set(room, peers);
    }
    // Catch up with what the room holds, then relay every local update to the others.
    for (const other of peers) {
      d.import(other.export({ mode: 'update' }));
      other.import(d.export({ mode: 'update' }));
    }
    peers.add(d);
    const stop = d.subscribeLocalUpdates((bytes) => {
      for (const other of peers!) if (other !== d) other.import(bytes);
    });
    return {
      room,
      disconnect: () => {
        stop();
        peers!.delete(d);
      },
    };
  },
};

// ----------------------------------------------------------------- a chart type and a chart option

const COMMON = [] as const;

/** A radar chart: its ECharts module registered by this plugin, never by the built-ins. */
export const radar = {
  id: 'acme.radar',
  label: 'Radar',
  octicon: 'north-star',
  modules: [...COMMON, RadarChart],
  option: (
    spec: { title?: string; data: { series: readonly { name?: string }[] } },
    data: {
      series: readonly { name: string; values: readonly (number | null)[] }[];
      categories: readonly string[];
    },
    theme: { chartColors: readonly string[] },
  ): ChartOption => ({
    color: [...theme.chartColors],
    title: spec.title !== undefined ? { text: spec.title } : undefined,
    radar: {
      indicator: data.categories.map((name) => ({ name })),
    },
    series: [
      {
        type: 'radar',
        data: data.series.map((s) => ({ name: s.name, value: s.values.map((v) => v ?? 0) })),
      },
    ],
  }),
  describe: (
    _spec: unknown,
    data: { series: readonly { name: string }[]; categories: readonly string[] },
  ) => `A radar chart of ${data.series.length} series over ${data.categories.length} axes.`,
};

/** A house style over every chart: Acme's palette, and a subtitle naming the plugin. */
export const acmeStyle = {
  id: 'acme.style',
  transform: (option: ChartOption): ChartOption => ({
    ...option,
    color: ['#cf222e', '#0969da', '#1a7f37', '#8250df'],
    title: { ...((option.title as Record<string, unknown> | undefined) ?? {}), subtext: 'Acme' },
  }),
};

/**
 * A chart renderer of the plugin's own: the option's series as a table of
 * figures, so charts show without ECharts. Contributed at `order: 500`, it
 * yields to `CellsChartsPlugin`'s ECharts renderer whenever that one is there.
 */
export function TextChartRenderer({ option, width, height }: ChartRendererProps) {
  const series =
    (option.series as readonly { name?: string; data?: readonly unknown[] }[] | undefined) ?? [];
  const title = (option.title as { text?: string } | undefined)?.text ?? 'Chart';
  return createElement(
    'div',
    {
      'data-acme-chart': '',
      style: { width, height, overflow: 'auto', font: '12px system-ui, sans-serif', padding: 4 },
    },
    createElement('strong', null, title),
    createElement(
      'ul',
      { style: { margin: 0, paddingLeft: 16 } },
      ...series.map((s, i) =>
        createElement(
          'li',
          { key: i },
          `${s.name ?? `Series ${i + 1}`}: ${(s.data ?? [])
            .map((d) =>
              typeof d === 'object' && d !== null && 'value' in d
                ? String((d as { value: unknown }).value)
                : String(d),
            )
            .join(', ')}`,
        ),
      ),
    ),
  );
}

// ----------------------------------------------------------------- the edit gate

/** Row 1 is the header row: no command may write into it. */
export const headerLocked = {
  check: ({ command }: { command: { type: string } & Record<string, unknown> }) => {
    const touchesRow0 = (() => {
      if (command.type === 'SET_CELLS') return (command.at as { row: number }).row === 0;
      if (command.type === 'CLEAR' || command.type === 'SET_STYLE' || command.type === 'UPPERCASE')
        return (command.zone as Zone).top === 0;
      if (command.type === 'DELETE_AXIS' || command.type === 'INSERT_AXIS')
        return command.axis === 'rows' && command.at === 0;
      return false;
    })();
    return touchesRow0 ? `Row 1 is Acme's header row: locked by ${ACME_PLUGIN}.` : true;
  },
};

// ----------------------------------------------------------------- Reactor commands, in the toolbar and the menu

const commands: ReactorCommand[] = [
  {
    id: 'acme.uppercase',
    name: 'UPPERCASE the selection',
    octicon: 'typography',
    category: 'Cells',
    keybinding: 'Mod+Shift+U',
    execute: ({ model }: CellsCommandArgument) => {
      const s = model.selection;
      const zone = s.zones[s.zones.length - 1];
      const r = model.dispatch({ type: 'UPPERCASE', sheet: s.sheet, zone });
      if (!r.ok) throw new Error(r.refusals[0].message);
    },
  },
  {
    id: 'acme.note',
    name: 'Note: check this',
    octicon: 'comment',
    category: 'Cells',
    execute: ({ model }: CellsCommandArgument) => {
      const { sheet, active } = model.selection;
      const has = notes(model.workbook).has(noteKey(sheet, active.row, active.col));
      const r = model.dispatch({
        type: 'SET_NOTE',
        sheet,
        row: active.row,
        col: active.col,
        text: has ? null : 'Check this',
      });
      if (!r.ok) throw new Error(r.refusals[0].message);
    },
  },
] as unknown as ReactorCommand[];

// ----------------------------------------------------------------- the plugin

/**
 * A kernel (`datalayer.cells.kernel`) that runs no Python: it counts the
 * words of a code cell's source, the result, and echoes the source as a
 * stream output. A host's kernel needs only `execute` (and `interrupt`).
 */
export const wordCount = {
  id: 'acme.words',
  label: 'Acme word count',
  connect: async () => ({
    async execute(code: string) {
      const source = programParts(code)?.source ?? '';
      const words = source.split(/\s+/).filter((w) => w !== '').length;
      return {
        outputs: [
          { output_type: 'stream' as const, name: 'stdout', text: source },
          { output_type: 'display_data' as const, data: { [RESULT_MIME]: { result: words } } },
        ],
      };
    },
  }),
};

export const AcmePlugin = definePlugin({
  name: ACME_PLUGIN,
  displayName: 'Acme',
  description: 'A plugin that reaches every extension point of Cells.',
  octicon: 'plug',
  commands,
  contributes: [
    contribution(CellsPatchOps, noteOp, { id: 'acme.note' }),
    contribution(CellsCommands, setNote, { id: 'SET_NOTE' }),
    contribution(CellsCommands, uppercase, { id: 'UPPERCASE' }),
    contribution(CellsFunctions, shout, { id: 'SHOUT' }),
    contribution(CellsFunctions, echo, { id: 'ECHO' }),
    contribution(CellsCellTypes, megaphone, { id: 'megaphone' }),
    contribution(CellsRenderLayers, noteMarks, { id: 'acme.noteMarks' }),
    contribution(CellsClipboard, notesClipboard, { id: 'acme.notes', order: 200 }),
    contribution(CellsFillRules, romanNumerals, { id: 'acme.roman', order: 50 }),
    contribution(
      CellsImporters,
      {
        id: 'acme.markdown',
        mime: 'text/markdown',
        extensions: ['.md'],
        read: async (input) =>
          readMarkdownTable(
            typeof input === 'string'
              ? input
              : input instanceof Uint8Array
                ? new TextDecoder().decode(input)
                : await new Response(input).text(),
          ),
      },
      { id: 'acme.markdown' },
    ),
    contribution(
      CellsExporters,
      {
        id: 'acme.markdown',
        mime: 'text/markdown',
        extension: '.md',
        write: async (model) => writeMarkdownTable(model as CellsModel),
      },
      { id: 'acme.markdown' },
    ),
    contribution(CellsDataSources, primes, { id: 'acme.primes' }),
    contribution(CellsCollabProvider, localRooms, { id: 'acme.local' }),
    contribution(
      CellsToolbarItems,
      { command: 'acme.uppercase', group: 'acme' },
      { id: 'acme.uppercase' },
    ),
    contribution(CellsToolbarItems, { command: 'acme.note', group: 'acme' }, { id: 'acme.note' }),
    contribution(
      CellsMenuItems,
      { command: 'acme.uppercase', group: 'acme' },
      { id: 'acme.uppercase' },
    ),
    contribution(CellsMenuItems, { command: 'acme.note', group: 'acme' }, { id: 'acme.note' }),
    contribution(CellsChartTypes, radar as never, { id: 'acme.radar' }),
    contribution(CellsChartOptions, acmeStyle as never, { id: 'acme.style' }),
    contribution(
      CellsChartRenderer,
      { id: 'acme.text', component: TextChartRenderer },
      { id: 'acme.text', order: 500 },
    ),
    contribution(CellsEditGate, headerLocked as never, { id: 'acme.headerLocked' }),
    contribution(CellsKernels, wordCount, { id: 'acme.words' }),
  ],
});

/** A second plugin contributing `SHOUT` again: a grid built with both is refused at start, naming the two. */
export const TwicePlugin = definePlugin({
  name: '@acme/twice',
  displayName: 'Acme, twice',
  contributes: [contribution(CellsFunctions, { ...shout }, { id: 'SHOUT' })],
});
