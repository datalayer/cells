/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Data sources (§3.11, C7-03): read-only, paged virtual columns. A sheet
 * binds a `datalayer.cells.dataSource` contribution at a cell
 * (`BIND_DATA_SOURCE`); its rows then show from there, read in pages of
 * {@link PAGE_ROWS} rows on demand, as the grid scrolls over them and as
 * formulas read them. A page's cells are `#BUSY!` until it arrives, then its
 * values are written into the sheet's store (no patches, no history: they are
 * not the workbook's content, and `toJSON` leaves them out), and the formulas
 * reading them recalculate. A bounded number of pages stays resident; the
 * least recently read is evicted (its cells emptied, read again on demand). A
 * page whose fetch fails shows `#N/A` with the source's sentence, and the
 * model tells `onDataSourceError`. Nothing writes into the bound zone: a
 * command whose patches would is refused.
 *
 * @module core/dataSources
 */

import type { CommandHandler, DataSource } from '../points/index.js';
import { CellsDataSources, type Resolved } from '../points/index.js';
import type { CommandResult } from './commands.js';
import { refuse } from './commands.js';
import type { Patch, PatchOp } from './patches.js';
import { cellError, type CellValue, type CellError } from './values.js';
import type { Sheet, Workbook } from './workbook.js';
import { type Position, type Zone, zoneToA1, zonesOverlap } from './zone.js';

/** Rows per page: one chunk of the cell store, so a page fills whole chunks. */
export const PAGE_ROWS = 1024;

/** How many pages stay resident by default (256 pages × 1,024 rows: 262,144 rows). */
export const DEFAULT_RESIDENT_PAGES = 256;

/**
 * A sheet's binding to a data source: which source, where its first row and
 * column land, and its shape as bound (so the zone is known without the
 * plugin, and a source that changed shape is refused rather than misread).
 */
export interface DataSourceBinding {
  readonly id: string;
  readonly at: Position;
  readonly rows: number;
  readonly cols: number;
}

/** The zone a binding covers on its sheet. */
export function bindingZone(b: DataSourceBinding): Zone {
  return {
    top: b.at.row,
    left: b.at.col,
    bottom: b.at.row + b.rows - 1,
    right: b.at.col + b.cols - 1,
  };
}

// ------------------------------------------------------------------ the patch op

export interface DataSourcePatch {
  readonly op: 'dataSource';
  readonly sheet: string;
  readonly before: DataSourceBinding | null;
  readonly after: DataSourceBinding | null;
}

export const dataSourceOp: PatchOp<DataSourcePatch> = {
  op: 'dataSource',
  apply(wb, p) {
    wb.sheet(p.sheet).dataSource = p.after === null ? null : { ...p.after, at: { ...p.after.at } };
  },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({
    op: 'dataSource',
    sheet: 's1',
    before: null,
    after: { id: 'example', at: { row: 1, col: 1 }, rows: 10, cols: 2 },
  }),
};

// ------------------------------------------------------------------ the command

/** Bind a data source at a cell, or unbind the sheet's (`source: null`). */
export interface BindDataSourceCommand {
  readonly type: 'BIND_DATA_SOURCE';
  readonly sheet: string;
  readonly source: string | null;
  /** Where the source's first row and column land; A1 by default. */
  readonly at?: Position;
}

export const bindDataSource: CommandHandler<BindDataSourceCommand> = {
  type: 'BIND_DATA_SOURCE',
  allow(context, c) {
    const { workbook } = context;
    if (!workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
    const sheet = workbook.sheet(c.sheet);
    if (c.source === null) {
      return sheet.dataSource === null
        ? refuse('InvalidArgument', `Sheet '${sheet.name}' is bound to no data source.`)
        : { ok: true };
    }
    if (typeof c.source !== 'string' || c.source === '')
      return refuse('InvalidArgument', 'BIND_DATA_SOURCE names a data source by id, or null.');
    const source = context.contributions(CellsDataSources).find((s) => s.id === c.source);
    if (source === undefined)
      return refuse('UnknownDataSource', `No plugin contributes the data source '${c.source}'.`);
    const at = c.at ?? { row: 0, col: 0 };
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    if (!ok(at.row) || !ok(at.col))
      return refuse('InvalidArgument', 'BIND_DATA_SOURCE lands at a cell: { row, col }.');
    if (sheet.dataSource !== null)
      return refuse(
        'InvalidArgument',
        `Sheet '${sheet.name}' is bound to the data source '${sheet.dataSource.id}' already; unbind it first.`,
      );
    const rows = source.rowCount;
    const cols = source.columns.length;
    if (rows < 1 || cols < 1)
      return refuse('InvalidArgument', `The data source '${source.id}' has no rows or no columns.`);
    if (at.row + rows > sheet.rows.count || at.col + cols > sheet.cols.count) {
      return refuse(
        'OutOfBounds',
        `The data source '${source.id}' has ${rows.toLocaleString('en-US')} rows and ${cols} columns: ` +
          `from ${zoneToA1({ top: at.row, left: at.col, bottom: at.row, right: at.col })} it reaches past ` +
          `the sheet's ${sheet.rows.count.toLocaleString('en-US')} rows and ${sheet.cols.count.toLocaleString('en-US')} columns.`,
      );
    }
    const zone = bindingZone({ id: source.id, at, rows, cols });
    if (!sheet.cells.isEmpty(zone))
      return refuse(
        'InvalidArgument',
        `${zoneToA1(zone)} holds cells; a data source lands on empty cells.`,
      );
    if (sheet.mergesIn(zone).length > 0)
      return refuse(
        'MergeOverlap',
        `${zoneToA1(zone)} holds merges; a data source lands on plain cells.`,
      );
    return { ok: true };
  },
  apply(context, c) {
    const sheet = context.workbook.sheet(c.sheet);
    const before = sheet.dataSource;
    if (c.source === null)
      return [{ op: 'dataSource', sheet: sheet.id, before, after: null } as Patch];
    const source = context.contributions(CellsDataSources).find((s) => s.id === c.source)!;
    const after: DataSourceBinding = {
      id: source.id,
      at: c.at ?? { row: 0, col: 0 },
      rows: source.rowCount,
      cols: source.columns.length,
    };
    return [{ op: 'dataSource', sheet: sheet.id, before, after } as Patch];
  },
};

// ------------------------------------------------------------------ the store

/** Where a sheet's binding stands: resolved to its source, or why not. */
export interface ResolvedDataSource {
  readonly binding: DataSourceBinding;
  readonly zone: Zone;
  /** The contribution, when an enabled plugin contributes it with the bound shape. */
  readonly source?: Resolved<DataSource>;
  /** Why `source` is missing, as the cells say it (`#N/A`). */
  readonly problem?: string;
}

export interface DataSourceError {
  readonly sheet: string;
  readonly source: string;
  /** The source's rows the page covers, inclusive. */
  readonly rows: { readonly from: number; readonly to: number };
  readonly error: Error;
}

export interface DataSourceStats {
  resident: number;
  loading: number;
  failed: number;
  /** Fetches started since the model was made. */
  fetches: number;
  /** Pages evicted since the model was made. */
  evictions: number;
}

interface Page {
  readonly sheet: string;
  readonly index: number;
  state: 'loading' | 'resident' | 'failed';
  error?: string;
}

/** What the engine asks of the store when a read finds nothing in the cells. */
export interface SourceReads {
  /**
   * The value a cell in a bound zone shows while its page is away (`#BUSY!`,
   * `#N/A`), or `undefined` for a plain or resident cell. Called on every
   * read of a plain cell, so a resident page read is the most recently read.
   */
  missing(sheet: string, row: number, col: number): CellValue | undefined;
  /** Request every page a zone needs; the error the read shows meanwhile, or `undefined` when all are resident (or the zone is outside). */
  ensureZone(sheet: string, zone: Zone): CellError | undefined;
  /** The bound zone of a sheet, or `undefined`. */
  zoneOf(sheet: string): Zone | undefined;
}

export interface DataSourceStoreOptions {
  readonly pages?: number;
  /** A page's values were written into the sheet (or emptied by an eviction). */
  readonly onWritten: (sheet: string, zone: Zone) => void;
  readonly onError: (error: DataSourceError) => void;
}

export class DataSourceStore implements SourceReads {
  readonly #workbook: Workbook;
  readonly #sources: { get(id: string): Resolved<DataSource> | undefined; revision: number };
  readonly #capacity: number;
  readonly #onWritten: (sheet: string, zone: Zone) => void;
  readonly #onError: (error: DataSourceError) => void;
  /** Pages by `${sheet}:${index}`, least recently read first. */
  readonly #pages = new Map<string, Page>();
  readonly #resolved = new Map<
    string,
    { revision: number; binding: DataSourceBinding; out: ResolvedDataSource }
  >();
  readonly stats: DataSourceStats = {
    resident: 0,
    loading: 0,
    failed: 0,
    fetches: 0,
    evictions: 0,
  };

  constructor(
    workbook: Workbook,
    sources: { get(id: string): Resolved<DataSource> | undefined; revision: number },
    options: DataSourceStoreOptions,
  ) {
    this.#workbook = workbook;
    this.#sources = sources;
    this.#capacity = options.pages ?? DEFAULT_RESIDENT_PAGES;
    if (!(Number.isInteger(this.#capacity) && this.#capacity >= 1))
      throw new Error(
        `dataSources.pages is a positive integer; ${String(options.pages)} was given.`,
      );
    this.#onWritten = options.onWritten;
    this.#onError = options.onError;
  }

  /** How many pages may stay resident. */
  get capacity(): number {
    return this.#capacity;
  }

  /** A sheet's binding resolved against the plugins, or `undefined` for an unbound sheet. */
  resolve(sheet: string): ResolvedDataSource | undefined {
    if (!this.#workbook.hasSheet(sheet)) return undefined;
    const binding = this.#workbook.sheet(sheet).dataSource;
    if (binding === null) return undefined;
    const revision = this.#sources.revision;
    const known = this.#resolved.get(sheet);
    if (known !== undefined && known.revision === revision && known.binding === binding)
      return known.out;
    return this.#resolveAgain(sheet, binding, revision, known);
  }

  #resolveAgain(
    sheet: string,
    binding: DataSourceBinding,
    revision: number,
    known: { revision: number; binding: DataSourceBinding; out: ResolvedDataSource } | undefined,
  ): ResolvedDataSource {
    const zone = bindingZone(binding);
    const source = this.#sources.get(binding.id);
    let out: ResolvedDataSource;
    if (source === undefined) {
      out = { binding, zone, problem: `No plugin contributes the data source '${binding.id}'.` };
    } else if (
      source.value.rowCount !== binding.rows ||
      source.value.columns.length !== binding.cols
    ) {
      out = {
        binding,
        zone,
        problem:
          `The data source '${binding.id}' has ${source.value.rowCount.toLocaleString('en-US')} rows and ` +
          `${source.value.columns.length} columns; the sheet binds ${binding.rows.toLocaleString('en-US')} rows and ` +
          `${binding.cols} columns. Bind it again.`,
      };
    } else out = { binding, zone, source };
    this.#resolved.set(sheet, { revision, binding, out });
    // The source resolves otherwise than before (a plugin off or on): its pages are stale.
    if (known !== undefined && known.binding === binding && known.out.source !== out.source)
      this.forget(sheet);
    return out;
  }

  zoneOf(sheet: string): Zone | undefined {
    return this.resolve(sheet)?.zone;
  }

  missing(sheet: string, row: number, col: number): CellValue | undefined {
    // Every read of a bound cell comes here (resident or not), so the page it touches is the most recently read.
    const binding = this.#workbook.sheet(sheet).dataSource;
    if (binding === null) return undefined;
    if (
      row < binding.at.row ||
      row >= binding.at.row + binding.rows ||
      col < binding.at.col ||
      col >= binding.at.col + binding.cols
    )
      return undefined;
    const r = this.resolve(sheet)!;
    if (r.source === undefined) return cellError('#N/A', r.problem);
    const index = Math.floor((row - r.zone.top) / PAGE_ROWS);
    const page = this.#page(sheet, index, r);
    if (page.state === 'resident') return undefined;
    return this.#stateValue(page, r);
  }

  ensureZone(sheet: string, zone: Zone): CellError | undefined {
    const r = this.resolve(sheet);
    if (r === undefined || !zonesOverlap(r.zone, zone)) return undefined;
    if (r.source === undefined) return cellError('#N/A', r.problem);
    const top = Math.max(zone.top, r.zone.top);
    const bottom = Math.min(zone.bottom, r.zone.bottom);
    const first = Math.floor((top - r.zone.top) / PAGE_ROWS);
    const last = Math.floor((bottom - r.zone.top) / PAGE_ROWS);
    const needed = last - first + 1;
    if (needed > this.#capacity) {
      return cellError(
        '#N/A',
        `Reading ${zoneToA1(zone)} needs ${needed.toLocaleString('en-US')} pages of the data source ` +
          `'${r.binding.id}'; ${this.#capacity} stay resident. Read a smaller range.`,
      );
    }
    let blocked: CellError | undefined;
    for (let i = first; i <= last; i += 1) {
      const page = this.#page(sheet, i, r);
      if (page.state !== 'resident' && blocked === undefined) blocked = this.#stateValue(page, r);
    }
    return blocked;
  }

  /** Drop every page of a sheet, emptying their cells; they are read again on demand. */
  forget(sheet: string): void {
    for (const [key, page] of [...this.#pages]) {
      if (page.sheet !== sheet) continue;
      this.#drop(key, page, true);
    }
  }

  /** Drop every page of every sheet without touching the cells (the workbook was replaced). */
  forgetAll(): void {
    this.#pages.clear();
    this.#resolved.clear();
    this.stats.resident = 0;
    this.stats.loading = 0;
    this.stats.failed = 0;
  }

  /** A patch is about to apply: a binding that goes or changes source takes its pages with it. */
  willApply(p: Patch): void {
    if (p.op !== 'dataSource') return;
    const { sheet, before, after } = p as unknown as DataSourcePatch;
    if (before === null) return;
    if (
      after === null ||
      after.id !== before.id ||
      after.rows !== before.rows ||
      after.cols !== before.cols
    )
      this.forget(sheet);
    // An anchor that only moved (rows inserted above it) keeps its pages: the cells moved with the rows.
  }

  /**
   * The refusal a command's patches earn when they would change a bound zone:
   * its cells, merges over it, or rows and columns inserted, deleted or moved
   * inside it. `undefined` when they leave every bound zone alone.
   */
  refuses(patches: readonly Patch[]): CommandResult | undefined {
    // Structural patches first: a delete carries its cells as a patch too, and the sentence should say which.
    const ordered = [
      ...patches.filter((p) => p.op.startsWith('axis-')),
      ...patches.filter((p) => !p.op.startsWith('axis-')),
    ];
    for (const p of ordered) {
      const sheet = (p as { sheet?: unknown }).sheet;
      if (typeof sheet !== 'string' || !this.#workbook.hasSheet(sheet)) continue;
      const binding = this.#workbook.sheet(sheet).dataSource;
      if (binding === null) continue;
      const zone = bindingZone(binding);
      const say = (what: string) =>
        refuse(
          'ReadOnly',
          `${zoneToA1(zone)} shows the data source '${binding.id}' and cannot be changed${what}.`,
        );
      if (p.op === 'cells') {
        if (zonesOverlap((p as unknown as { zone: Zone }).zone, zone)) return say('');
      } else if (p.op === 'merges') {
        const after = (p as unknown as { after: readonly Zone[] }).after;
        if (after.some((m) => zonesOverlap(m, zone))) return say(': no merge over it');
      } else if (p.op === 'axis-insert' || p.op === 'axis-delete' || p.op === 'axis-move') {
        const a = p as unknown as { axis: 'rows' | 'cols'; at: number; n: number; to?: number };
        const lo = a.axis === 'rows' ? zone.top : zone.left;
        const hi = a.axis === 'rows' ? zone.bottom : zone.right;
        const inside = (i: number) => i > lo && i <= hi;
        const crosses = a.at <= hi && a.at + a.n - 1 >= lo;
        if (p.op === 'axis-insert' && inside(a.at)) return say(`: no ${a.axis} inserted inside it`);
        if (p.op === 'axis-delete' && crosses) return say(`: no ${a.axis} deleted from it`);
        if (p.op === 'axis-move' && (crosses || inside(a.to!)))
          return say(`: no ${a.axis} moved into or out of it`);
      }
    }
    return undefined;
  }

  #stateValue(page: Page, r: ResolvedDataSource): CellError {
    if (page.state === 'failed')
      return cellError(
        '#N/A',
        `The data source '${r.binding.id}' failed for rows ${(page.index * PAGE_ROWS + 1).toLocaleString('en-US')}–` +
          `${Math.min((page.index + 1) * PAGE_ROWS, r.binding.rows).toLocaleString('en-US')}: ${page.error}`,
      );
    return cellError(
      '#BUSY!',
      `The data source '${r.binding.id}' is reading rows ${(page.index * PAGE_ROWS + 1).toLocaleString('en-US')}–${Math.min((page.index + 1) * PAGE_ROWS, r.binding.rows).toLocaleString('en-US')}.`,
    );
  }

  /** The page, touched as most recently read; requested when unknown. */
  #page(sheet: string, index: number, r: ResolvedDataSource): Page {
    const key = `${sheet}:${index}`;
    const known = this.#pages.get(key);
    if (known !== undefined) {
      this.#pages.delete(key);
      this.#pages.set(key, known);
      return known;
    }
    const page: Page = { sheet, index, state: 'loading' };
    this.#pages.set(key, page);
    this.stats.loading += 1;
    this.stats.fetches += 1;
    const from = index * PAGE_ROWS;
    const to = Math.min(from + PAGE_ROWS - 1, r.binding.rows - 1);
    const source = r.source!.value;
    const settle = (
      columns: readonly (readonly CellValue[])[] | undefined,
      error: Error | undefined,
    ) => {
      if (this.#pages.get(key) !== page || page.state !== 'loading') return; // forgotten meanwhile
      this.stats.loading -= 1;
      if (error === undefined && columns !== undefined) {
        const shape =
          Array.isArray(columns) && columns.length === r.binding.cols
            ? columns.find((c) => !Array.isArray(c) || c.length !== to - from + 1)
            : columns;
        if (shape !== undefined) {
          error = new Error(
            `the data source '${source.id}' answered ${Array.isArray(columns) ? columns.length : 'no'} columns ` +
              `for rows ${from + 1}–${to + 1}, not ${r.binding.cols} columns of ${to - from + 1} rows.`,
          );
        }
      }
      if (error !== undefined) {
        page.state = 'failed';
        page.error = error.message;
        this.stats.failed += 1;
        this.#onError({ sheet, source: source.id, rows: { from, to }, error });
        this.#onWritten(sheet, this.#pageZone(r, index));
        return;
      }
      this.#evictFor(page);
      page.state = 'resident';
      this.stats.resident += 1;
      this.#write(sheet, r, index, columns!, from, to);
      this.#onWritten(sheet, this.#pageZone(r, index));
    };
    try {
      Promise.resolve(source.fetch({ from, to })).then(
        (columns) => settle(columns, undefined),
        (reason: unknown) =>
          settle(undefined, reason instanceof Error ? reason : new Error(String(reason))),
      );
    } catch (reason) {
      settle(undefined, reason instanceof Error ? reason : new Error(String(reason)));
    }
    return page;
  }

  #pageZone(r: ResolvedDataSource, index: number): Zone {
    const z = r.zone;
    return {
      top: z.top + index * PAGE_ROWS,
      left: z.left,
      bottom: Math.min(z.top + (index + 1) * PAGE_ROWS - 1, z.bottom),
      right: z.right,
    };
  }

  #write(
    sheet: string,
    r: ResolvedDataSource,
    _index: number,
    columns: readonly (readonly CellValue[])[],
    from: number,
    to: number,
  ): void {
    const cells = this.#workbook.sheet(sheet).cells;
    const z = r.zone;
    for (let c = 0; c < columns.length; c += 1) {
      const col = z.left + c;
      const values = columns[c];
      for (let i = 0; i <= to - from; i += 1) {
        const v = values[i];
        const row = z.top + from + i;
        if (v === null || v === undefined) continue;
        cells.set(row, col, { value: v, style: cells.styleAt(row, col) });
      }
    }
  }

  /** Make room for a page about to become resident: the least recently read resident pages go. */
  #evictFor(keep: Page): void {
    while (this.stats.resident >= this.#capacity) {
      let victim: [string, Page] | undefined;
      for (const entry of this.#pages) {
        if (entry[1].state === 'resident' && entry[1] !== keep) {
          victim = entry;
          break;
        }
      }
      if (victim === undefined) return;
      this.#drop(victim[0], victim[1], true);
      this.stats.evictions += 1;
    }
  }

  #drop(key: string, page: Page, emptyCells: boolean): void {
    this.#pages.delete(key);
    if (page.state === 'resident') this.stats.resident -= 1;
    else if (page.state === 'loading') this.stats.loading -= 1;
    else this.stats.failed -= 1;
    if (page.state !== 'resident' || !emptyCells) return;
    // The zone from the sheet's own binding (still the old one while a patch is about to apply).
    const binding = this.#workbook.sheet(page.sheet).dataSource;
    if (binding === null) return;
    const zone = this.#pageZone({ binding, zone: bindingZone(binding) }, page.index);
    const cells = this.#workbook.sheet(page.sheet).cells;
    for (const [row, col] of [...cells.entries(zone)]) cells.set(row, col, null);
    this.#onWritten(page.sheet, zone);
  }
}

/** A sheet's bound zone, from the workbook alone (no plugin needed): what `toJSON` leaves out. */
export function boundZone(sheet: Sheet): Zone | undefined {
  return sheet.dataSource === null ? undefined : bindingZone(sheet.dataSource);
}
