/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateWorkbook } from '@datalayer/cells/core';
import { parseCsvText } from '@datalayer/cells/csv';
import { describe, expect, it } from 'vitest';
import { checkCellsFile as checkWith, describeProblems, fileKind } from '../check';
import cellsPlugin, { cellsFiles, DEFAULT_THEME, PLUGIN_NAME } from '../index';

// The grid's modules as vitest resolves them (lib/, through the config's aliases): a native
// import from the test would reach the monorepo's reactor checkout, which Node cannot load as is.
const modules = { validateWorkbook, parseCsvText };
const checkCellsFile = (file: string, text: string, options: { maxCells?: number } = {}) =>
  checkWith(file, text, modules, options);

const workbook = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    sheets: [
      {
        id: 's1',
        name: 'Budget',
        rows: {
          '0': { cells: { '0': { v: 'Item' }, '1': { v: 3 } } },
          '1': { cells: { '0': { f: 'B1*2' } } },
        },
      },
    ],
    styles: [{}],
    ...over,
  });

describe('checkCellsFile', () => {
  it('passes a workbook the grid can load, and counts its cells', async () => {
    expect(checkCellsFile('budget.cells.json', workbook())).toEqual({
      problems: [],
      summary: { sheets: 1, cells: 3 },
    });
  });

  it('says where JSON stops being JSON', async () => {
    const { problems } = checkCellsFile('a.cells.json', '{ "version": ');
    expect(problems[0].where).toBe('file');
    expect(problems[0].message).toMatch(/^not valid JSON: /);
  });

  it("refuses what the grid's loader refuses, with the path of the bad field", async () => {
    const { problems } = checkCellsFile('a.cells.json', workbook({ version: 2 }));
    expect(problems).toEqual([
      { file: 'a.cells.json', where: 'version', message: expect.stringMatching(/version 1/) },
    ]);
    const bad = JSON.parse(workbook()) as { styles: unknown[] };
    bad.styles = [{}, { blink: true }];
    const { problems: style } = checkCellsFile('b.cells.json', JSON.stringify(bad));
    expect(style[0].where).toBe('styles[1]');
    expect(style[0].message).toMatch(/'blink' is not a style property/);
  });

  it('parses a CSV file, refuses an empty one and a ragged one', async () => {
    expect(checkCellsFile('sales.csv', 'Month,North\nJan,10\nFeb,12\n')).toEqual({
      problems: [],
      summary: { sheets: 1, cells: 6 },
    });
    expect(checkCellsFile('empty.csv', '\n').problems[0]).toMatchObject({
      where: 'file',
      message: 'the CSV file holds no value',
    });
    expect(checkCellsFile('ragged.csv', 'a,b\n1,2,3\n').problems).toEqual([
      { file: 'ragged.csv', where: 'row 2', message: '3 fields, where the first row has 2' },
    ]);
  });

  it('holds the site to its cell limit, and reads only the two kinds of file', async () => {
    expect(checkCellsFile('a.cells.json', workbook(), { maxCells: 2 }).problems).toEqual([
      { file: 'a.cells.json', where: 'file', message: '3 cells, more than the 2 this site allows' },
    ]);
    expect(checkCellsFile('notes.txt', 'x').problems[0].message).toBe(
      'a cells file is a .cells.json workbook or a .csv file',
    );
    expect(fileKind('a.cells.json')).toBe('workbook');
    expect(fileKind('a.CSV')).toBe('csv');
    expect(fileKind('a.json')).toBeUndefined();
  });

  it('prints one problem per line, with the file and where', () => {
    expect(
      describeProblems([
        { file: 'a.cells.json', where: 'version', message: 'x' },
        { file: 'b.csv', where: 'row 2', message: 'y' },
      ]),
    ).toBe('a.cells.json (version): x\nb.csv (row 2): y');
  });
});

describe('the plugin', () => {
  it('checks every cells file under the site, and stops the build on one it cannot show', async () => {
    const site = await mkdtemp(path.join(tmpdir(), 'cells-site-'));
    await mkdir(path.join(site, 'cells', 'deep'), { recursive: true });
    await writeFile(path.join(site, 'cells', 'budget.cells.json'), workbook());
    await writeFile(path.join(site, 'cells', 'deep', 'sales.csv'), 'a,b\n1,2\n');
    await writeFile(path.join(site, 'cells', 'readme.md'), '# not a sheet');
    const plugin = cellsPlugin({ siteDir: site }, { theme: 'datalayer', modules });
    expect(plugin.name).toBe(PLUGIN_NAME);
    expect(await cellsFiles(path.join(site, 'cells'))).toEqual([
      path.join(site, 'cells', 'budget.cells.json'),
      path.join(site, 'cells', 'deep', 'sales.csv'),
    ]);
    expect(await plugin.loadContent()).toEqual({ files: 2, cells: 7 });
    const data: unknown[] = [];
    await plugin.contentLoaded({ content: {}, actions: { setGlobalData: (d) => data.push(d) } });
    expect(data).toEqual([{ theme: 'datalayer', editable: false }]);
    expect(plugin.getPathsToWatch()).toEqual([
      path.join(site, 'cells', '**', '*.cells.json'),
      path.join(site, 'cells', '**', '*.csv'),
    ]);
    await writeFile(path.join(site, 'cells', 'broken.cells.json'), workbook({ version: 3 }));
    await expect(plugin.loadContent()).rejects.toThrow(
      /docusaurus-plugin-cells: sheets that cannot be shown:\ncells\/broken.cells.json \(version\): /,
    );
    const none = cellsPlugin({ siteDir: path.join(site, 'nowhere') }, { modules });
    expect(await none.loadContent()).toEqual({ files: 0, cells: 0 });
    expect(DEFAULT_THEME).toBe('loop');
    expect(() => cellsPlugin({ siteDir: site }, { maxCells: 0 })).toThrow(
      'maxCells must be at least 1',
    );
  });

  it('keeps the grid out of the server bundle and pins React to the site', () => {
    const plugin = cellsPlugin({ siteDir: process.cwd() });
    const server = plugin.configureWebpack({}, true) as {
      resolve: { alias: Record<string, unknown> };
    };
    const browser = plugin.configureWebpack({}, false) as {
      resolve: { alias: Record<string, unknown> };
    };
    expect(server.resolve.alias['@datalayer/cells-docusaurus/client']).toBe(false);
    expect(String(browser.resolve.alias['@datalayer/cells-docusaurus/client'])).toMatch(
      /client[\\/]CellsClient\.js$/,
    );
    expect(browser.resolve.alias['react$']).toMatch(/react/);
  });
});
