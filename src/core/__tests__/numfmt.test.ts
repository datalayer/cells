/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileFormat, FormatCodeError } from '../numfmt.js';

interface Golden {
  format: string;
  value: number;
  shows: string;
}

const GOLDEN = (
  JSON.parse(
    readFileSync(new URL('../../../tests/format/numfmt/golden.json', import.meta.url), 'utf8'),
  ) as {
    cases: Golden[];
  }
).cases;

/**
 * General in a cell shows what fits: LibreOffice's API string carries every
 * digit (0.333333333333333), Excel and Cells show at most 11 characters
 * (0.333333333). Those cases are checked against Excel's rule instead.
 */
const WIDTH_BOUND = (g: Golden) => g.format === 'General' && g.shows.length > 11;

describe('number formats, as LibreOffice shows them', () => {
  it('has the golden cases', () => {
    expect(GOLDEN.filter((g) => !WIDTH_BOUND(g)).length).toBeGreaterThanOrEqual(60);
  });

  for (const g of GOLDEN.filter((x) => !WIDTH_BOUND(x))) {
    it(`${JSON.stringify(g.format)} shows ${g.value} as ${JSON.stringify(g.shows)}`, () => {
      expect(compileFormat(g.format)(g.value).text).toBe(g.shows);
    });
  }

  it('shows General in at most 11 characters, as Excel does in a cell', () => {
    expect(compileFormat('General')(1 / 3).text).toBe('0.333333333');
  });

  it("writes the locale's separators and names", () => {
    const fr = {
      decimal: ',',
      group: ' ',
      months: [
        'janvier',
        'février',
        'mars',
        'avril',
        'mai',
        'juin',
        'juillet',
        'août',
        'septembre',
        'octobre',
        'novembre',
        'décembre',
      ],
      days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    };
    expect(compileFormat('#,##0.00', fr)(1234.5).text).toBe('1 234,50');
    expect(compileFormat('d mmmm yyyy', fr)(45000).text).toBe('15 mars 2023');
  });

  it("gives a section's colour", () => {
    expect(compileFormat('0.00;[Red]-0.00')(-1).color).toBe('#ff0000');
    expect(compileFormat('[Blue]0')(1).color).toBe('#0000ff');
  });

  it('formats text through the @ section, and leaves other values alone', () => {
    expect(compileFormat('0.00;-0.00;0;"Note: "@')('hi').text).toBe('Note: hi');
    expect(compileFormat('0.00')(true).text).toBe('TRUE');
    expect(compileFormat('0.00')({ error: '#N/A' }).text).toBe('#N/A');
  });

  it.each([
    ['"open', /never closes/],
    ['[Red', /never closes/],
    ['0;0;0;0;0', /at most four/],
    ['# ?/?', /fractions/],
    ['[Wobble]0', /is not a colour/],
  ])('refuses %s with a sentence', (code, message) => {
    expect(() => compileFormat(code)).toThrow(FormatCodeError);
    expect(() => compileFormat(code)).toThrow(message);
  });
});
