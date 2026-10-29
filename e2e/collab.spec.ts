/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { spawn } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';

/**
 * C6-04: presence across two pages, two users in one room of the rooms
 * server (`scripts/collab-server.mjs`, started here on a free port). Each page
 * shows the other user's selection, in the other user's colour, within the
 * collab budget (§4: a remote change painted ≤ 50 ms after its update
 * arrives); `collab.remotePaintMs` is measured on a single-cell change.
 */

const BUDGET_MS = 50;
const RUNS = 12;

type Rooms = { url: string; close(): Promise<void> };
type CollabWindow = {
  cellsCollab: {
    model: {
      remotePresence: readonly {
        user: { name: string; color: string };
        active: { row: number; col: number };
        editing?: { row: number; col: number };
      }[];
      value(sheet: string, row: number, col: number): unknown;
    };
    ready: Promise<boolean>;
    paintAfter(test: (m: unknown) => boolean, timeout?: number): Promise<number>;
  };
};

let rooms: Rooms;
test.beforeAll(async () => {
  // Its own process: lexical-loro's server logs every message, which stays out of the report.
  const child = spawn(process.execPath, ['scripts/collab-server.mjs'], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = /(ws:\/\/[^/\s]+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.once('exit', (code) => reject(new Error(`the rooms server exited (${code}): ${out}`)));
  });
  rooms = {
    url,
    close: async () => {
      child.kill();
    },
  };
});
test.afterAll(async () => {
  await rooms?.close();
});

// Colours no theme of the grid uses, so a pixel of one is the peer's.
const ADA = { name: 'Ada', color: '#b000b0', rgb: [0xb0, 0x00, 0xb0] };
const GRACE = { name: 'Grace', color: '#008c8c', rgb: [0x00, 0x8c, 0x8c] };

async function open(page: Page, room: string, who: typeof ADA) {
  const q = new URLSearchParams({ ws: rooms.url, room, name: who.name, color: who.color });
  await page.goto(`/e2e-collab.html?${q}`);
  await page.waitForFunction(() => 'cellsCollab' in window);
  await page.evaluate(() => (window as unknown as CollabWindow).cellsCollab.ready);
  const grid = page.getByRole('grid', { name: `Sheet of ${who.name}` });
  await grid.waitFor();
  return grid;
}

/** The overlay canvas' pixels of a colour (±12 per channel): a peer's outline and name tag. */
function pixelsOf(page: Page, rgb: number[]) {
  return page.evaluate((rgb) => {
    const canvas = document.querySelectorAll('[role="grid"] canvas')[1] as HTMLCanvasElement;
    const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (
        d[i + 3] > 200 &&
        Math.abs(d[i] - rgb[0]) <= 12 &&
        Math.abs(d[i + 1] - rgb[1]) <= 12 &&
        Math.abs(d[i + 2] - rgb[2]) <= 12
      )
        n += 1;
    return n;
  }, rgb);
}

/** Arm a measure on `page`: the peer `name` with its active cell at (row, col). */
function seesPeerAt(page: Page, name: string, row: number, col: number) {
  return page.evaluate(
    ({ name, row, col }) =>
      (window as unknown as CollabWindow).cellsCollab.paintAfter((m) =>
        (m as CollabWindow['cellsCollab']['model']).remotePresence.some(
          (p) => p.user.name === name && p.active.row === row && p.active.col === col,
        ),
      ),
    { name, row, col },
  );
}

const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
};

test('two pages show each other’s selection in the peer’s colour within the collab budget, and a remote cell change is painted within it', async ({
  browser,
}, info) => {
  const room = `presence-${Date.now()}`;
  const a = await browser.newContext({ viewport: { width: 1000, height: 600 } });
  const b = await browser.newContext({ viewport: { width: 1000, height: 600 } });
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const errors: string[] = [];
  for (const p of [pageA, pageB]) p.on('pageerror', (e) => errors.push(e.message));
  const gridA = await open(pageA, room, ADA);
  const gridB = await open(pageB, room, GRACE);

  // Each sees the other at A1 once both joined; nobody draws its own colour as a peer.
  await expect
    .poll(() =>
      pageB.evaluate(() =>
        (window as unknown as CollabWindow).cellsCollab.model.remotePresence.map(
          (p) => p.user.name,
        ),
      ),
    )
    .toEqual(['Ada']);
  await expect
    .poll(() =>
      pageA.evaluate(() =>
        (window as unknown as CollabWindow).cellsCollab.model.remotePresence.map(
          (p) => p.user.name,
        ),
      ),
    )
    .toEqual(['Grace']);
  expect(await pixelsOf(pageA, ADA.rgb)).toBe(0);
  expect(await pixelsOf(pageB, GRACE.rgb)).toBe(0);
  await expect.poll(() => pixelsOf(pageB, ADA.rgb)).toBeGreaterThan(0);
  await expect.poll(() => pixelsOf(pageA, GRACE.rgb)).toBeGreaterThan(0);

  // Ada moves down column A, one key a move; each move is measured on Grace's page.
  const presence: number[] = [];
  await gridA.focus();
  await pageA.keyboard.press('Control+Home');
  for (let i = 1; i <= RUNS; i += 1) {
    const seen = seesPeerAt(pageB, 'Ada', i, 0);
    await pageA.keyboard.press('ArrowDown');
    presence.push(await seen);
  }
  // Grace moves down column B; measured on Ada's page.
  await gridB.focus();
  await pageB.keyboard.press('Control+Home');
  await pageB.keyboard.press('ArrowRight');
  for (let i = 1; i <= RUNS; i += 1) {
    const seen = seesPeerAt(pageA, 'Grace', i, 1);
    await pageB.keyboard.press('ArrowDown');
    presence.push(await seen);
  }
  // The outline follows: Ada's colour is on Grace's page, Grace's on Ada's.
  expect(await pixelsOf(pageB, ADA.rgb)).toBeGreaterThan(0);
  expect(await pixelsOf(pageA, GRACE.rgb)).toBeGreaterThan(0);

  // A single-cell change typed on Ada's page, painted on Grace's: collab.remotePaintMs.
  const cells: number[] = [];
  await gridA.focus();
  await pageA.keyboard.press('Control+Home');
  for (let i = 0; i < RUNS; i += 1) {
    const text = `v${i}`;
    const seen = pageB.evaluate(
      ({ text, row }) =>
        (window as unknown as CollabWindow).cellsCollab.paintAfter(
          (m) => (m as CollabWindow['cellsCollab']['model']).value('s1', row, 0) === text,
        ),
      { text, row: i },
    );
    await pageA.keyboard.type(text);
    await pageA.keyboard.press('Enter');
    cells.push(await seen);
  }
  await expect(gridB.getByRole('gridcell', { name: `v${RUNS - 1}`, exact: true })).toHaveCount(1);

  const figures = {
    'collab.remotePaintMs': Math.round(p95(cells) * 10) / 10,
    'collab.remotePresencePaintMs': Math.round(p95(presence) * 10) / 10,
    runs: { cells: cells.length, presence: presence.length },
    max: { cells: Math.max(...cells), presence: Math.max(...presence) },
  };
  console.log(`collab figures (p95, ms): ${JSON.stringify(figures)}`);
  await info.attach('collab-figures', {
    body: JSON.stringify(figures, null, 2),
    contentType: 'application/json',
  });
  expect(figures['collab.remotePaintMs']).toBeLessThanOrEqual(BUDGET_MS);
  expect(figures['collab.remotePresencePaintMs']).toBeLessThanOrEqual(BUDGET_MS);
  expect(errors).toEqual([]);
  await a.close();
  await b.close();
});
