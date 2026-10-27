/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import {
  callAt,
  canPoint,
  namePrefix,
  referenceText,
  referencesIn,
  toggleAnchors,
} from '../editing.js';

describe('editing a formula', () => {
  it('knows where a reference can be pointed at', () => {
    expect(canPoint('=', 1)).toBe(true);
    expect(canPoint('=SUM(', 5)).toBe(true);
    expect(canPoint('=A1+', 4)).toBe(true);
    expect(canPoint('=A1+ ', 5)).toBe(true);
    expect(canPoint('=SUM(A1,', 8)).toBe(true);
    expect(canPoint('=A1', 3)).toBe(false);
    expect(canPoint('=5%', 3)).toBe(false);
    expect(canPoint('abc', 3)).toBe(false);
  });

  it('writes the reference pointed at', () => {
    expect(referenceText({ row: 8, col: 1 }, { row: 1, col: 1 })).toBe('B2:B9');
    expect(referenceText({ row: 0, col: 0 }, { row: 0, col: 0 }, 'My sheet')).toBe("'My sheet'!A1");
    expect(referenceText({ row: 0, col: 0 }, { row: 0, col: 0 }, 'Data')).toBe('Data!A1');
  });

  it('finds the references to colour', () => {
    expect(referencesIn('=SUM(B2:B9)+$C$1*Other!A1+A:A')).toEqual([
      { start: 5, end: 10, top: 1, bottom: 8, left: 1, right: 1 },
      { start: 12, end: 16, top: 0, bottom: 0, left: 2, right: 2 },
      { start: 17, end: 25, sheet: 'Other', top: 0, bottom: 0, left: 0, right: 0 },
      { start: 26, end: 29, left: 0, right: 0 },
    ]);
  });

  it('toggles anchors with F4: $A$1, A$1, $A1, A1', () => {
    let state = { text: '=A1+B2:C3', caret: 3 };
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = toggleAnchors(state.text, state.caret)!;
      seen.push(state.text);
    }
    expect(seen).toEqual(['=$A$1+B2:C3', '=A$1+B2:C3', '=$A1+B2:C3', '=A1+B2:C3']);
    expect(toggleAnchors('=A1+B2:C3', 9)?.text).toBe('=A1+$B$2:$C$3');
    expect(toggleAnchors('=SUM(1)', 5)).toBeUndefined();
  });

  it('finds the name being typed, and the call and argument the caret is in', () => {
    expect(namePrefix('=SU', 3)).toEqual({ start: 1, prefix: 'SU' });
    expect(namePrefix('=A1+vl', 6)).toEqual({ start: 4, prefix: 'vl' });
    expect(namePrefix('=A1+12', 6)).toBeUndefined();
    expect(namePrefix('=SUM(', 5)).toBeUndefined();
    expect(callAt('=SUM(A1,', 8)).toEqual({ name: 'SUM', argument: 1 });
    expect(callAt('=IF(A1>0,ROUND(B1,', 18)).toEqual({ name: 'ROUND', argument: 1 });
    expect(callAt('=IF(A1>0,ROUND(B1,2),', 21)).toEqual({ name: 'IF', argument: 2 });
    expect(callAt('=A1+1', 5)).toBeUndefined();
  });
});
