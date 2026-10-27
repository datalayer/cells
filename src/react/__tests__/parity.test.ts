/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import * as core from '../../core/index.js';
import * as cells from '../../index.js';
import { CORE_EXPORTS, MODEL_MEMBERS } from '../parity.js';

function check(
  map: Record<string, { kind: string; name?: string }>,
  names: string[],
  what: string,
): string[] {
  const problems: string[] = [];
  for (const name of names)
    if (!(name in map)) problems.push(`${what} '${name}' has no React surface in react/parity.ts`);
  for (const [name, surface] of Object.entries(map)) {
    if (!names.includes(name))
      problems.push(`react/parity.ts maps '${name}', which is not a ${what} any more`);
    if (surface.kind === 'hook' || surface.kind === 'component') {
      const target = (cells as Record<string, unknown>)[surface.name!];
      if (typeof target !== 'function')
        problems.push(
          `'${name}' maps to ${surface.kind} '${surface.name}', which @datalayer/cells does not export`,
        );
    } else if (surface.kind === 'reexport') {
      if (!(name in cells))
        problems.push(`'${name}' is a re-export that @datalayer/cells does not re-export`);
      const value = (core as Record<string, unknown>)[name];
      const isClass =
        typeof value === 'function' && /^class\b/.test(Function.prototype.toString.call(value));
      // An error class is thrown and caught, not held: it needs no hook.
      const isError =
        typeof value === 'function' &&
        (value as { prototype?: unknown }).prototype instanceof Error;
      if (isClass && !isError)
        problems.push(`'${name}' is a class: it holds state, so it needs a hook, not a re-export`);
    }
  }
  return problems;
}

/** The public members of the model, read from a live instance and its prototype. */
function modelMembers(): string[] {
  const model = core.createCellsModel();
  const own = Object.keys(model);
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(model)).filter(
    (n) => n !== 'constructor',
  );
  return [...new Set([...own, ...proto])];
}

describe('API parity: everything the core does is doable from React', () => {
  it('maps every runtime export of ./core to a React surface', () => {
    expect(check(CORE_EXPORTS, Object.keys(core), 'core export')).toEqual([]);
  });

  it('maps every public member of the model to a React surface', () => {
    expect(check(MODEL_MEMBERS, modelMembers(), 'model member')).toEqual([]);
  });

  it('fails for a core export added without its React surface', () => {
    const problems = check(CORE_EXPORTS, [...Object.keys(core), 'newCoreThing'], 'core export');
    expect(problems).toEqual([
      "core export 'newCoreThing' has no React surface in react/parity.ts",
    ]);
  });

  it('fails for a surface naming a hook that is not exported', () => {
    const problems = check(
      { ...CORE_EXPORTS, parseA1: { kind: 'hook', name: 'useNothing' } },
      Object.keys(core),
      'core export',
    );
    expect(problems).toEqual([
      "'parseA1' maps to hook 'useNothing', which @datalayer/cells does not export",
    ]);
  });
});
