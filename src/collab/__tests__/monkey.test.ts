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
import { type CellsModel, createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';
import { canonical, command, LIMITS, random } from './party.js';

const ROUNDS = Number(process.env.CELLS_MONKEY_ROUNDS ?? 10_000);
const SEED =
  process.env.CELLS_MONKEY_SEED === 'random'
    ? Math.floor(Math.random() * 2 ** 31)
    : Number(process.env.CELLS_MONKEY_SEED ?? 20261028);
const PEERS = 3;

interface Peer {
  readonly model: CellsModel;
  readonly doc: LoroDoc;
  readonly binding: LoroBinding;
  /** The version of each other peer's document last delivered to this one. */
  readonly seen: Map<number, Uint8Array>;
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
