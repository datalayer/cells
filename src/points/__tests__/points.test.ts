/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  buildReactorFromPlugins,
  contribution,
  defineContributionPoint,
  definePlugin,
} from '@datalayer/reactor';
import { describe, expect, it, vi } from 'vitest';
import { CellsCorePlugin, createCellsModel } from '../../core/index.js';
import {
  CELLS_POINTS,
  CellsCollabProvider,
  CellsCommands,
  type CellsPlatform,
  firstContribution,
  optionalContribution,
  PointTable,
} from '../index.js';

const Thing = defineContributionPoint<{ name: string }>('test.thing');

function platform(...plugins: Parameters<typeof buildReactorFromPlugins>[0]) {
  const reactor = buildReactorFromPlugins(plugins);
  reactor.start();
  return reactor;
}

describe('the Cells points on Reactor', () => {
  it('declares every point on the core plugin', () => {
    const ids = new Set(CELLS_POINTS.map((p) => p.id));
    expect(ids.size).toBe(CELLS_POINTS.length);
    for (const id of ids) expect(id.startsWith('datalayer.cells.')).toBe(true);
    const reactor = platform(CellsCorePlugin);
    const declared = reactor.getManifest(CellsCorePlugin.name)?.contributionPoints ?? [];
    expect(new Set(declared)).toEqual(ids);
  });

  it('resolves a point from two plugins into one table', () => {
    const reactor = platform(
      definePlugin({
        name: '@a/one',
        contributes: [contribution(Thing, { name: 'X' }, { id: 'x' })],
      }),
      definePlugin({
        name: '@b/two',
        contributes: [contribution(Thing, { name: 'Y' }, { id: 'y' })],
      }),
    );
    const table = new PointTable(reactor as CellsPlatform, Thing, {
      label: 'thing',
      key: (t) => t.name,
    });
    expect([...table.keys()].sort()).toEqual(['X', 'Y']);
    expect(table.get('Y')?.plugin).toBe('@b/two');
  });

  it('refuses a key contributed twice, naming both plugins', () => {
    const reactor = platform(
      definePlugin({
        name: '@acme/fx',
        contributes: [contribution(Thing, { name: 'FX' }, { id: 'a' })],
      }),
      definePlugin({
        name: '@other/fx',
        contributes: [contribution(Thing, { name: 'FX' }, { id: 'b' })],
      }),
    );
    const table = new PointTable(reactor as CellsPlatform, Thing, {
      label: 'thing',
      key: (t) => t.name,
    });
    expect(() => table.get('FX')).toThrow(/'FX' is contributed twice.*@acme\/fx.*@other\/fx/);
  });

  it("drops a disabled plugin's contributions after the revision moves", () => {
    const reactor = platform(
      definePlugin({
        name: '@a/one',
        contributes: [contribution(Thing, { name: 'X' }, { id: 'x' })],
      }),
    );
    const table = new PointTable(reactor as CellsPlatform, Thing, {
      label: 'thing',
      key: (t) => t.name,
    });
    expect(table.get('X')).toBeDefined();
    reactor.disable('@a/one');
    expect(table.get('X')).toBeUndefined();
    reactor.enable('@a/one');
    expect(table.get('X')).toBeDefined();
  });

  it('reads a point only when the platform changed', () => {
    const reactor = platform(
      definePlugin({
        name: '@a/one',
        contributes: [contribution(Thing, { name: 'X' }, { id: 'x' })],
      }),
    );
    const spy = vi.spyOn(reactor, 'getContributions');
    const table = new PointTable(reactor as CellsPlatform, Thing, {
      label: 'thing',
      key: (t) => t.name,
    });
    for (let i = 0; i < 100; i += 1) table.get('X');
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('refuses a malformed contribution, naming its plugin', () => {
    const reactor = platform(
      definePlugin({
        name: '@bad/one',
        contributes: [contribution(Thing, { name: '' }, { id: 'z' })],
      }),
    );
    const table = new PointTable(reactor as CellsPlatform, Thing, {
      label: 'thing',
      key: (t) => t.name,
      check: (t) => {
        if (!t.name) throw new Error('a thing has a name');
      },
    });
    expect(() => table.all()).toThrow(
      /@bad\/one contributes a malformed thing \(id 'z'\): a thing has a name/,
    );
  });

  it('picks the single winner of a one-provider point, and refuses a tie', () => {
    const provider = (name: string, order: number) =>
      definePlugin({
        name,
        contributes: [
          contribution(CellsCollabProvider, { id: name, connect: () => null }, { id: name, order }),
        ],
      });
    expect(
      optionalContribution(
        platform(CellsCorePlugin),
        CellsCollabProvider,
        'collaboration provider',
      ),
    ).toBeUndefined();
    expect(() =>
      firstContribution(platform(CellsCorePlugin), CellsCollabProvider, 'collaboration provider'),
    ).toThrow(/No plugin contributes a collaboration provider/);
    const two = platform(CellsCorePlugin, provider('@a/loro', 10), provider('@b/other', 20));
    expect(firstContribution(two, CellsCollabProvider, 'collaboration provider').plugin).toBe(
      '@a/loro',
    );
    const tie = platform(CellsCorePlugin, provider('@a/loro', 10), provider('@b/other', 10));
    expect(() => firstContribution(tie, CellsCollabProvider, 'collaboration provider')).toThrow(
      /same order 10.*@a\/loro.*@b\/other/,
    );
  });

  it("runs a model on the host's platform, and refuses one without the core plugin", () => {
    const reactor = platform(CellsCorePlugin);
    const model = createCellsModel({ reactor });
    expect(model.reactor).toBe(reactor);
    expect(() => createCellsModel({ reactor: platform() })).toThrow(/no @datalayer\/cells-core/);
    expect(() => createCellsModel({ reactor, plugins: [] })).toThrow(/not both/);
  });

  it('lets a plugin add a command that the model dispatches', () => {
    const Shout = definePlugin({
      name: '@acme/shout',
      contributes: [
        contribution(CellsCommands, {
          type: 'SHOUT',
          apply: ({ workbook }) => [
            {
              op: 'cells',
              sheet: workbook.sheets[0].id,
              zone: { top: 0, left: 0, bottom: 0, right: 0 },
              before: {
                rows: new Int32Array(0),
                cols: new Int32Array(0),
                values: [],
                formulas: [],
                styles: new Uint16Array(0),
              },
              after: {
                rows: Int32Array.of(0),
                cols: Int32Array.of(0),
                values: ['HEY'],
                formulas: [undefined],
                styles: Uint16Array.of(0),
              },
            },
          ],
        }),
      ],
    });
    const model = createCellsModel({ plugins: [Shout] });
    expect(model.dispatch({ type: 'SHOUT' })).toEqual({ ok: true });
    expect(model.value('s1', 0, 0)).toBe('HEY');
    model.reactor.disable('@acme/shout');
    expect(model.dispatch({ type: 'SHOUT' })).toMatchObject({
      ok: false,
      refusals: [{ reason: 'UnknownCommand' }],
    });
  });
});
