/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Measure Loro schemas for a sheet at 100k and 1 M rows (C6-02): document
 * size, snapshot export and import time, the first read, and resident memory. Run with
 * `node --expose-gc scripts/loro-schema.mjs`.
 *
 * - `list`: the axis as a LoroList of row ids, the cells as one LoroMap keyed
 *   `<rowId>.<colId>` (the schema of version 1 as first written);
 * - `keys`: the axis as a LoroMap of explicit rows only (row id → order key),
 *   implicit rows ordered by their index, and the same cell map;
 * - `bands`: as `keys`, the cells in one LoroMap per band of 1,024 rows.
 */

import { LoroDoc, LoroMap } from 'loro-crdt';

const heap = () => {
  globalThis.gc?.();
  globalThis.gc?.();
  // Loro's memory is WebAssembly memory: the resident set says it, the JS heap does not.
  return process.memoryUsage().rss;
};

function build(kind, rows, cols) {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  if (kind === 'list') {
    const axis = doc.getList('rows:s1');
    const ids = Array.from({ length: rows }, (_, i) => `b${i.toString(36)}`);
    for (let i = 0; i < rows; i += 1) axis.push(ids[i]);
  } else {
    // Only rows that moved or were inserted are explicit: none, for a loaded sheet.
    doc.getMap('rowkeys:s1');
  }
  const value = (r, c) => (r * 7 + c) / 4;
  if (kind === 'bands') {
    const bands = doc.getMap('bands:s1');
    for (let b = 0; b * 1024 < rows; b += 1) {
      const band = bands.setContainer(b.toString(36), new LoroMap());
      for (let r = b * 1024; r < Math.min(rows, (b + 1) * 1024); r += 1)
        for (let c = 0; c < cols; c += 1)
          band.set(`${(r - b * 1024).toString(36)}.${c}`, value(r, c));
    }
  } else {
    const cells = doc.getMap('cells:s1');
    for (let r = 0; r < rows; r += 1)
      for (let c = 0; c < cols; c += 1) cells.set(`b${r.toString(36)}.${c}`, value(r, c));
  }
  doc.commit();
  return doc;
}

/** One case: built, exported, then imported and read in this process, its resident memory measured around the import. */
function measure(kind, rows) {
  const cols = rows === 100_000 ? 10 : 1;
  const t0 = performance.now();
  const doc = build(kind, rows, cols);
  const built = performance.now() - t0;
  const t1 = performance.now();
  const snapshot = doc.export({ mode: 'snapshot' });
  const exported = performance.now() - t1;
  return { cols, built, exported, snapshot };
}

const [, , kind, rowsArg, file] = process.argv;
if (file !== undefined) {
  // A fresh process: import the snapshot and read every cell, its resident memory measured around it.
  const { readFileSync } = await import('node:fs');
  const snapshot = new Uint8Array(readFileSync(file));
  const before = heap();
  const t2 = performance.now();
  const copy = new LoroDoc();
  copy.import(snapshot);
  const imported = performance.now() - t2;
  const t3 = performance.now();
  const n =
    kind === 'bands'
      ? Object.values(copy.getMap('bands:s1').toJSON()).reduce(
          (a, m) => a + Object.keys(m).length,
          0,
        )
      : copy.getMap('cells:s1').size;
  const read = performance.now() - t3;
  const after = heap();
  console.log(
    JSON.stringify({
      cells: n,
      importMs: Math.round(imported),
      readMs: Math.round(read),
      rssMB: Math.round((after - before) / 1048576),
    }),
  );
} else {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cells-loro-'));
  try {
    for (const rows of [100_000, 1_000_000])
      for (const k of ['list', 'keys', 'bands']) {
        const { cols, built, exported, snapshot } = measure(k, rows);
        const path = join(dir, `${k}-${rows}.loro`);
        writeFileSync(path, snapshot);
        const read = JSON.parse(
          execFileSync(process.execPath, [
            '--expose-gc',
            new URL(import.meta.url).pathname,
            k,
            String(rows),
            path,
          ]).toString(),
        );
        console.log(
          JSON.stringify({
            kind: k,
            rows,
            cols,
            snapshotKB: Math.round(snapshot.length / 1024),
            buildMs: Math.round(built),
            exportMs: Math.round(exported),
            ...read,
          }),
        );
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
