/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The persisted state of a workbook: sheets, their axes and cells, merges and
 * frozen panes, and the pools cells reference (strings, styles, formulas).
 * Only patches write it (core/patches); the model reads it through getters.
 *
 * @module core/workbook
 */

import { Axis } from './axis.js';
import type { ChartSpec } from './charts.js';
import type { CodeCell } from './code.js';
import type { DataSourceBinding } from './dataSources.js';
import { FormulaTable, SheetCells } from './cells.js';
import { StringPool } from './strings.js';
import { StyleTable } from './styles.js';
import { type Zone, zonesOverlap } from './zone.js';

/** The size limits of a sheet. Excel's by default. */
export interface Limits {
  readonly rows: number;
  readonly cols: number;
  readonly rowHeight: number;
  readonly colWidth: number;
}

/** Excel's grid: 1,048,576 rows by 16,384 columns, rows 21 px high and columns 100 px wide. */
export const DEFAULT_LIMITS: Limits = {
  rows: 1_048_576,
  cols: 16_384,
  rowHeight: 21,
  colWidth: 100,
};

/** How many rows and columns are frozen. */
export interface Frozen {
  readonly rows: number;
  readonly cols: number;
}

/** A sheet: its axes, cells, merges, frozen panes, charts and data source. */
export class Sheet {
  readonly id: string;
  name: string;
  readonly rows: Axis;
  readonly cols: Axis;
  readonly cells: SheetCells;
  /** Merged zones, disjoint. */
  merges: Zone[] = [];
  frozen: Frozen = { rows: 0, cols: 0 };
  /** Charts, by id (§3.12): data, like merges; drawing them is `./charts`. */
  readonly charts = new Map<string, ChartSpec>();
  /** Code cells (§3.13), by `rowId.colId`: they follow their cell through inserts, deletes and moves. */
  readonly code = new Map<string, CodeCell>();
  /** The data source bound to the sheet (§3.11, C7-03), or none; its rows are read in pages, not stored. */
  dataSource: DataSourceBinding | null = null;

  constructor(id: string, name: string, limits: Limits, cells: SheetCells) {
    this.id = id;
    this.name = name;
    this.rows = new Axis({ count: limits.rows, defaultSize: limits.rowHeight });
    this.cols = new Axis({ count: limits.cols, defaultSize: limits.colWidth });
    this.cells = cells;
  }

  /** The merge holding a position, or `undefined`. */
  mergeAt(row: number, col: number): Zone | undefined {
    return this.merges.find(
      (m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right,
    );
  }

  /** Merges overlapping a zone. */
  mergesIn(zone: Zone): Zone[] {
    return this.merges.filter((m) => zonesOverlap(m, zone));
  }
}

/** The workbook's storage: sheets, and the string pool, style table and formula table they share. */
export class Workbook {
  readonly limits: Limits;
  /**
   * What new sheet ids start with. Peers of one shared document each set
   * their own (the collaboration binding does), so two sheets added at once
   * on two peers never share an id.
   */
  sheetIdPrefix = 's';
  readonly strings = new StringPool();
  readonly styles = new StyleTable();
  readonly formulas = new FormulaTable();
  /** In tab order. */
  readonly sheets: Sheet[] = [];
  #nextSheet = 1;

  constructor(limits: Limits = DEFAULT_LIMITS) {
    for (const [key, value] of Object.entries(limits)) {
      if (!(typeof value === 'number' && value > 0))
        throw new Error(`limits.${key} must be positive; ${value} was given.`);
    }
    this.limits = limits;
  }

  /** A new, detached sheet with a fresh id; `ADD_SHEET` attaches it through a patch. */
  createSheet(name: string, id?: string): Sheet {
    const sheetId = id ?? this.#freshSheetId();
    if (this.sheets.some((s) => s.id === sheetId))
      throw new Error(`A sheet with id '${sheetId}' exists already.`);
    return new Sheet(
      sheetId,
      name,
      this.limits,
      new SheetCells({ strings: this.strings, formulas: this.formulas }),
    );
  }

  /** The sheet of that id; throws a sentence naming the ids there are. */
  sheet(id: string): Sheet {
    const sheet = this.sheets.find((s) => s.id === id);
    if (sheet === undefined) {
      throw new Error(
        `No sheet '${id}'; the workbook has ${this.sheets.map((s) => s.id).join(', ') || 'none'}.`,
      );
    }
    return sheet;
  }

  hasSheet(id: string): boolean {
    return this.sheets.some((s) => s.id === id);
  }

  /** The sheet of that name, case-insensitively, as Excel matches names. */
  sheetByName(name: string): Sheet | undefined {
    const lower = name.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower);
  }

  /** A name no sheet has: `Sheet1`, `Sheet2`, … */
  freshSheetName(): string {
    for (let i = 1; ; i += 1) if (this.sheetByName(`Sheet${i}`) === undefined) return `Sheet${i}`;
  }

  #freshSheetId(): string {
    for (;;) {
      const id = `${this.sheetIdPrefix}${this.#nextSheet++}`;
      if (!this.hasSheet(id)) return id;
    }
  }
}
