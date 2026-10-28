/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The monkey party with a Python peer (C8-05): two TypeScript peers on their
 * `LoroBinding` and one `datalayer_cells` peer (`dev/monkey_peer.py`, the
 * live workbook over loro-py) apply random commands — the Python peer through
 * the package's API: values, spills, clears, *Undo the cell's writes*, charts
 * added, changed and removed — and exchange their updates in a random order.
 * Once every update is everywhere, the TypeScript peers hold the same
 * workbook, and the Python peer reads the values and charts they show (a
 * formula's value is computed on the page, not stored, so formula cells are
 * left out of the Python side's comparison).
 *
 * Needs a Python with `loro` and the package's dependencies (`pip install -e
 * '.[live]'`): `CELLS_PYTHON` names it (`python3` by default); without one the
 * test says so and skips. `CELLS_MONKEY_PY_ROUNDS` (2,000 by default) and
 * `CELLS_MONKEY_SEED` set the party, as for the TypeScript-only one.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LoroDoc, VersionVector } from 'loro-crdt';
import { afterAll, describe, expect, it } from 'vitest';
import { type CellsModel, createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';
import { canonical, command, LIMITS, random } from './party.js';

const PYTHON = process.env.CELLS_PYTHON ?? 'python3';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROUNDS = Number(process.env.CELLS_MONKEY_PY_ROUNDS ?? 2_000);
const SEED =
  process.env.CELLS_MONKEY_SEED === 'random'
    ? Math.floor(Math.random() * 2 ** 31)
    : Number(process.env.CELLS_MONKEY_SEED ?? 20261028);

const ready =
  spawnSync(PYTHON, ['-c', 'import loro, datalayer_cells.live'], { cwd: ROOT }).status === 0;
if (!ready)
  console.log(
    `monkey party with a Python peer: skipped, ${PYTHON} has no loro or datalayer_cells (pip install -e '.[live]', or set CELLS_PYTHON)`,
  );

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** The Python peer: one JSON line per request, one back. */
class PythonPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: AsyncIterator<string>;

  constructor(seed: number) {
    this.#child = spawn(PYTHON, ['dev/monkey_peer.py', JSON.stringify(LIMITS), String(seed)], {
      cwd: ROOT,
    });
    this.#child.stderr.on('data', (d) => process.stderr.write(d));
    this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
  }

  async ask(message: Record<string, unknown>): Promise<any> {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = await this.#lines.next();
    if (next.done) throw new Error('the Python peer stopped');
    const out = JSON.parse(next.value);
    if (out.error !== undefined) throw new Error(out.error);
    return out;
  }

  close(): void {
    this.#child.kill();
  }
}

interface TsPeer {
  readonly model: CellsModel;
  readonly doc: LoroDoc;
  readonly binding: LoroBinding;
}

async function toPython(from: TsPeer, py: PythonPeer): Promise<void> {
  const vv = VersionVector.decode(unb64((await py.ask({ op: 'vv' })).vv));
  await py.ask({ op: 'import', data: b64(from.doc.export({ mode: 'update', from: vv })) });
}

async function fromPython(py: PythonPeer, to: TsPeer): Promise<void> {
  const { data } = await py.ask({ op: 'export', vv: b64(to.doc.oplogVersion().encode()) });
  to.doc.import(unb64(data));
}

function deliver(from: TsPeer, to: TsPeer): void {
  to.doc.import(from.doc.export({ mode: 'update', from: to.doc.oplogVersion() }));
}

/** A peer's workbook as canonical JSON, its merges in reading order (a merge made here is appended, one projected from the document comes sorted). */
function normalized(p: TsPeer): string {
  const json = p.model.toJSON();
  return canonical({
    ...json,
    sheets: json.sheets.map((s) =>
      s.merges === undefined
        ? s
        : { ...s, merges: [...s.merges].sort((x, y) => x.top - y.top || x.left - y.left) },
    ),
  });
}

let python: PythonPeer | undefined;
afterAll(() => python?.close());

describe('the monkey party with a Python peer', () => {
  it.skipIf(!ready)(
    `2 TypeScript peers and a Python peer, ${ROUNDS} rounds, seed ${SEED}, converge`,
    async () => {
      const r = random(SEED);
      const peers: TsPeer[] = [];
      for (let i = 0; i < 2; i += 1) {
        const model = createCellsModel({ limits: LIMITS });
        const doc = new LoroDoc();
        doc.setPeerId(i + 1);
        if (i > 0) doc.import(peers[0].doc.export({ mode: 'snapshot' }));
        peers.push({ model, doc, binding: new LoroBinding(model, doc, { peer: String(i + 1) }) });
      }
      // The first peer names its sheet before the party, so the Python peer starts on a seeded document.
      python = new PythonPeer(SEED);
      await python.ask({ op: 'import', data: b64(peers[0].doc.export({ mode: 'snapshot' })) });
      const seen = { checks: 0, compared: 0, filled: 0, charts: 0 };
      /** Everything delivered everywhere, twice round; then the peers agree, and the Python peer reads what the page shows. */
      const converge = async (peer: PythonPeer) => {
        for (let k = 0; k < 2; k += 1) {
          for (const p of peers) {
            await fromPython(peer, p);
            await toPython(p, peer);
          }
          deliver(peers[0], peers[1]);
          deliver(peers[1], peers[0]);
        }
        const [a, b] = peers;
        // A formula's value is in the JSON once computed, and computing is lazy (a chart's check
        // reads its ranges): every value is computed on both peers before their JSON is compared.
        const zone = { top: 0, left: 0, bottom: LIMITS.rows - 1, right: LIMITS.cols - 1 };
        for (const p of peers) for (const s of p.model.sheets) p.model.toRows(zone, s.id);
        expect(normalized(b)).toBe(normalized(a));
        // What the Python peer reads is what the page shows.
        const shown = (await peer.ask({ op: 'show' })).sheets as {
          id: string;
          values: unknown[][];
          charts: Record<string, unknown>;
        }[];
        const json = a.model.toJSON();
        expect(shown.map((s) => s.id)).toEqual(json.sheets.map((s) => s.id));
        for (const sheet of json.sheets) {
          const py = shown.find((s) => s.id === sheet.id)!;
          const page = a.model.toRows(zone, sheet.id);
          const rows = (sheet as any).rows ?? {};
          for (let row = 0; row < LIMITS.rows; row += 1)
            for (let col = 0; col < LIMITS.cols; col += 1) {
              if (rows[row]?.cells?.[col]?.f !== undefined) continue;
              expect([sheet.id, row, col, py.values[row][col]]).toEqual([
                sheet.id,
                row,
                col,
                page[row][col],
              ]);
              seen.compared += 1;
              if (page[row][col] !== null) seen.filled += 1;
            }
          expect(canonical(py.charts)).toBe(canonical(sheet.charts ?? {}));
          seen.charts += Object.keys(py.charts).length;
        }
        seen.checks += 1;
      };
      const counts = { ts: 0, py: 0, refused: 0, undone: 0 };
      for (let round = 0; round < ROUNDS; round += 1) {
        // Every 500 rounds the party stops for a check, so the comparisons see charts and full sheets too.
        if (round > 0 && round % 500 === 0) await converge(python);
        const who = r.int(3);
        const roll = r.int(10);
        if (who === 2) {
          if (roll < 6) {
            const out = await python.ask({ op: 'act' });
            if (out.applied) counts.py += 1;
            else counts.refused += 1;
          } else await fromPython(python, r.pick(peers));
          continue;
        }
        const p = peers[who];
        if (roll < 6) {
          const c = command(p.model, r);
          if (c === undefined) continue;
          if (p.model.dispatch(c).ok) counts.ts += 1;
          else counts.refused += 1;
        } else if (roll < 7) {
          if (p.binding.undo()) counts.undone += 1;
        } else if (roll < 9) await toPython(p, python);
        else deliver(peers[1 - who], p);
      }
      await converge(python);
      expect(counts.py).toBeGreaterThan(ROUNDS / 20);
      console.log(
        `monkey party with a Python peer: seed ${SEED}, ${counts.ts} TypeScript and ${counts.py} Python commands applied, ${counts.refused} refused, ${counts.undone} undone, ${seen.checks} checks, ${seen.compared} cells compared (${seen.filled} not empty), ${seen.charts} charts`,
      );
    },
    600_000,
  );
});
