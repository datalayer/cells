/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `./core` runs with no React and no DOM: in Node, in a worker. It may reach
 * the Reactor (its extension architecture), never React.
 */

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => {
  throw new Error('core reached react');
});
vi.mock('react-dom', () => {
  throw new Error('core reached react-dom');
});

describe('the core entry', () => {
  it('loads and works without React, a window or a document', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const core = await import('../index.js');
    const model = core.createCellsModel();
    expect(
      model.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 0, col: 0 },
        cells: [[1, 'two']],
      }),
    ).toEqual({
      ok: true,
    });
    expect(model.toRows({ top: 0, left: 0, bottom: 0, right: 1 })).toEqual([[1, 'two']]);
  });
});
