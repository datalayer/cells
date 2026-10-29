/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * The live workbook in Python, from the page, in Chrome: the test page's code
 * cells run on a kernel of the local Jupyter server (`make jupyter-server`'s
 * configuration, started here unless one already answers on its port), bound
 * to the page's document over the `datalayer.cells` comm. A value the kernel
 * writes appears on the page and in a second peer on the same document; a
 * DataFrame spilled over a non-empty cell is refused with `#SPILL!` and
 * leaves the range as it was on both peers, and one spilled into empty cells
 * fills its range on both.
 *
 * The kernel's environment needs `datalayer_cells[live]`, pandas, ipykernel
 * and jupyter_server; `CELLS_JUPYTER` names the `jupyter` to start (default:
 * the one on the PATH). Without one the suite skips, unless
 * `CELLS_CODE_KERNEL=1` (CI) makes that a failure.
 */

const SERVER = 'http://localhost:8888/api/jupyter-server';
const JUPYTER = process.env.CELLS_JUPYTER ?? 'jupyter';
const REQUIRED = process.env.CELLS_CODE_KERNEL === '1';

type Model = { value(sheet: string, row: number, col: number): unknown };
type CodeWindow = {
  cellsCode: {
    model: Model;
    peer: Model;
    run(ref: string): Promise<void>;
    code(
      ref: string,
    ):
      | { result?: unknown; outputs: { output_type: string; ename?: string; evalue?: string }[] }
      | undefined;
  };
};

const answers = async () => {
  try {
    return (await fetch(`${SERVER}/api`)).ok;
  } catch {
    return false;
  }
};

let server: ChildProcess | undefined;
test.beforeAll(async () => {
  if (await answers()) return;
  const found = spawnSync(JUPYTER, ['server', '--version'], { encoding: 'utf8' }).status === 0;
  if (!found) {
    if (REQUIRED) throw new Error(`No Jupyter server: \`${JUPYTER} server --version\` failed.`);
    test.skip(true, 'No Jupyter server (CELLS_JUPYTER); CELLS_CODE_KERNEL=1 makes this a failure.');
    return;
  }
  // The checkout first on the kernel's path, so it imports this datalayer_cells.
  server = spawn(JUPYTER, ['server', '--config=dev/jupyter_server_config.py'], {
    env: {
      ...process.env,
      PYTHONPATH: [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(':'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  server.stderr!.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const until = Date.now() + 60_000;
  while (!(await answers())) {
    if (Date.now() > until || server.exitCode !== null)
      throw new Error(`The Jupyter server did not start:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});
test.afterAll(() => {
  server?.kill();
});

test('a kernel’s write reaches the page and a second peer; a spill is refused over a non-empty cell and fills empty ones', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/e2e-code.html');
  await page.waitForFunction(() => 'cellsCode' in window);
  await expect(page.getByRole('grid', { name: 'The page' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'The second peer' })).toBeVisible();
  const read = (who: 'model' | 'peer', row: number, col: number) =>
    page.evaluate(
      ({ who, row, col }) => (window as unknown as CodeWindow).cellsCode[who].value('s1', row, col),
      { who, row, col },
    );

  // The second peer has the page's table from the document.
  await expect.poll(() => read('peer', 2, 1)).toBe(15);

  // C2 writes F2 through the comm and sums B2:B7.
  await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.run('C2'));
  const c2 = await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.code('C2'));
  expect(c2?.outputs.filter((o) => o.output_type === 'error')).toEqual([]);
  expect(c2?.result).toBe(129);
  await expect.poll(() => read('model', 1, 5)).toBe(42);
  await expect.poll(() => read('peer', 1, 5)).toBe(42);
  // The result is the page's, written as the code cell's value: the peer reads it too.
  await expect.poll(() => read('peer', 1, 2)).toBe(129);

  // C4 spills over E1:F3, where E1 holds "Taken": refused, nothing written.
  await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.run('C4'));
  const c4 = await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.code('C4'));
  const error = c4?.outputs.find((o) => o.output_type === 'error');
  expect(error?.ename, JSON.stringify(c4?.outputs)).toBe('SpillError');
  expect(error?.evalue).toContain('#SPILL!');
  expect(c4?.result).toEqual({ error: '#ERROR!' });
  for (const who of ['model', 'peer'] as const) {
    expect(await read(who, 0, 4)).toBe('Taken');
    expect(await read(who, 2, 4)).toBe(null);
    expect(await read(who, 1, 5)).toBe(42);
  }

  // C6 spills into H1:I3, empty: the header and two rows, on both peers.
  await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.run('C6'));
  const c6 = await page.evaluate(() => (window as unknown as CodeWindow).cellsCode.code('C6'));
  expect(c6?.outputs.filter((o) => o.output_type === 'error')).toEqual([]);
  for (const who of ['model', 'peer'] as const) {
    await expect.poll(() => read(who, 0, 7)).toBe('a');
    expect(await read(who, 0, 8)).toBe('b');
    expect(await read(who, 2, 7)).toBe(2);
    expect(await read(who, 2, 8)).toBe(4);
  }
  expect(errors).toEqual([]);
});
