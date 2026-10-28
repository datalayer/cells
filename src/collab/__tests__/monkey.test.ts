/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The monkey party (C6-05), after o-spreadsheet's: N peers on one Loro
 * document apply random commands (cells, formulas, row and column inserts,
 * deletes and moves, merges, sizes, sheets) and exchange their updates in a
 * random order, some held back for a while; then every update is delivered
 * and every peer must hold the same workbook and the same values.
 *
 * `CELLS_MONKEY_ROUNDS` (10,000 by default) and `CELLS_MONKEY_SEED` (fixed by
 * default; `random` for a new one, printed) set the party; the nightly job
 * runs it with a random seed.
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { type CellsModel, type Command, createCellsModel, zoneRef } from '../../core/index.js';

const z = (top: number, left: number, bottom: number, right: number) => ({
  top,
  left,
  bottom,
  right,
});
import { LoroBinding } from '../binding.js';

const ROUNDS = Number(process.env.CELLS_MONKEY_ROUNDS ?? 10_000);
const SEED =
  process.env.CELLS_MONKEY_SEED === 'random'
    ? Math.floor(Math.random() * 2 ** 31)
    : Number(process.env.CELLS_MONKEY_SEED ?? 20261028);
const PEERS = 3;
const LIMITS = { rows: 30, cols: 8 };

/** A seeded generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)] };
}

interface Peer {
  readonly model: CellsModel;
  readonly doc: LoroDoc;
  readonly binding: LoroBinding;
  /** The version of each other peer's document last delivered to this one. */
  readonly seen: Map<number, Uint8Array>;
}

function command(m: CellsModel, r: ReturnType<typeof random>): Command | undefined {
  const sheet = r.pick(m.sheets).id;
  const row = r.int(LIMITS.rows - 4);
  const col = r.int(LIMITS.cols - 2);
  const zone = { top: row, left: col, bottom: row + r.int(2), right: col + r.int(2) };
  switch (r.int(13)) {
    case 0:
    case 1:
    case 2:
      return { type: 'SET_CELLS', sheet, at: { row, col }, cells: [[r.int(100), `t${r.int(10)}`]] };
    case 3:
      return {
        type: 'SET_CELLS',
        sheet,
        at: { row, col },
        cells: [[{ formula: r.pick(['A1+1', 'SUM(A1:B3)', '$B$2*2', 'C3&"!"']) }]],
      };
    case 4:
      return { type: 'CLEAR', sheet, zone };
    case 5:
      return {
        type: 'INSERT_AXIS',
        sheet,
        axis: r.pick(['rows', 'cols'] as const),
        at: r.int(5),
        n: 1 + r.int(2),
      };
    case 6:
      return {
        type: 'DELETE_AXIS',
        sheet,
        axis: r.pick(['rows', 'cols'] as const),
        at: r.int(6),
        n: 1,
      };
    case 7:
      return { type: 'MOVE_AXIS', sheet, axis: 'rows', at: r.int(4), n: 1, to: 6 + r.int(4) };
    case 8:
      return r.int(2) === 0 ? { type: 'MERGE', sheet, zone } : { type: 'UNMERGE', sheet, zone };
    case 9:
      return {
        type: 'SET_STYLE',
        sheet,
        zone,
        style: { bold: r.int(2) === 0, fill: r.pick(['#ff0', '#0ff']) },
      };
    case 10:
      return { type: 'RESIZE_AXIS', sheet, axis: 'cols', from: col, to: col, size: 40 + r.int(80) };
    case 11: {
      // Charts (C10-08): inserted on the sheet's first cells, retitled, retyped, moved, deleted.
      const charts = [...m.sheet(sheet).charts.keys()];
      const name = m.sheet(sheet).name;
      const id = charts.length > 0 ? r.pick(charts) : undefined;
      switch (id === undefined ? 0 : r.int(4)) {
        case 0:
          return {
            type: 'INSERT_CHART',
            sheet,
            chart: {
              type: r.pick(['column', 'line', 'pie'] as const),
              anchor: {
                kind: 'cells',
                from: { row, col, dx: 0, dy: 0 },
                to: { row: row + 3, col: col + 1, dx: 0, dy: 0 },
              },
              data: {
                series: [
                  {
                    values: zoneRef(name, z(0, 0, 2, 0)),
                    categories: zoneRef(name, z(0, 1, 2, 1)),
                  },
                  { values: zoneRef(name, z(0, 1, 2, 1)) },
                ],
                by: 'columns',
                headers: { row: false, column: false },
                blanks: 'gap',
              },
              legend: 'bottom',
            },
          };
        case 1:
          return {
            type: 'UPDATE_CHART',
            sheet,
            id: id!,
            changes:
              r.int(2) === 0
                ? { title: `T${r.int(100)}` }
                : { type: r.pick(['column', 'line', 'bar'] as const) },
          };
        case 2:
          return { type: 'MOVE_CHART', sheet, id: id!, to: { row, col } };
        default:
          return { type: 'DELETE_CHART', sheet, id: id! };
      }
    }
    default:
      return m.sheets.length < 3 && r.int(2) === 0
        ? { type: 'ADD_SHEET', name: `S${r.int(1000)}` }
        : m.sheets.length > 1
          ? { type: 'DELETE_SHEET', sheet }
          : undefined;
  }
}

/** Deliver what `from` has that `to` has not. */
function deliver(from: Peer, to: Peer): void {
  to.doc.import(from.doc.export({ mode: 'update', from: to.doc.oplogVersion() }));
}

/** What a peer shows: its workbook, and every cell's evaluated value. */
function shown(p: Peer) {
  const json = p.model.toJSON();
  const values = p.model.sheets.map((s) =>
    p.model.toRows({ top: 0, left: 0, bottom: LIMITS.rows - 1, right: LIMITS.cols - 1 }, s.id),
  );
  return canonical({ json, values });
}

/** JSON with its keys sorted at every level: two peers' workbooks compare whatever order their fields were written in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'object' && x !== null && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );

describe('the monkey party', () => {
  it(`${PEERS} peers, ${ROUNDS} rounds of random commands and deliveries, seed ${SEED}, converge`, () => {
    const r = random(SEED);
    const first = createCellsModel({ limits: LIMITS });
    const peers: Peer[] = [];
    for (let i = 0; i < PEERS; i += 1) {
      const model = i === 0 ? first : createCellsModel({ limits: LIMITS });
      const doc = new LoroDoc();
      doc.setPeerId(i + 1);
      if (i > 0) doc.import(peers[0].doc.export({ mode: 'snapshot' }));
      const binding = new LoroBinding(model, doc, { peer: String(i + 1) });
      peers.push({ model, doc, binding, seen: new Map() });
    }
    let refused = 0;
    let applied = 0;
    let undone = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const p = r.pick(peers);
      const roll = r.int(10);
      if (roll < 6) {
        const c = command(p.model, r);
        if (c === undefined) continue;
        if (p.model.dispatch(c).ok) applied += 1;
        else refused += 1;
      } else if (roll < 7) {
        if (p.binding.undo()) undone += 1;
      } else {
        // A delivery from one peer to another, in whatever order the dice say.
        const q = r.pick(peers.filter((x) => x !== p));
        deliver(q, p);
      }
    }
    // Everything delivered everywhere, twice round, so every peer has every update.
    for (let k = 0; k < 2; k += 1)
      for (const a of peers) for (const b of peers) if (a !== b) deliver(a, b);
    const first0 = shown(peers[0]);
    for (const p of peers.slice(1)) expect(shown(p)).toBe(first0);
    expect(applied).toBeGreaterThan(ROUNDS / 5);
    console.log(
      `monkey party: seed ${SEED}, ${applied} commands applied, ${refused} refused, ${undone} undone`,
    );
  }, 600_000);
});
