/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { variantTheme, withoutVariables } from '../theme.js';

describe('a primer-addons variant on the canvas', () => {
  it('gives the canvas colours, not the CSS expressions of the VS Code tokens', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const mode of ['light', 'dark'] as const) {
      const theme = await variantTheme('vscode', root, mode);
      // Every token of VS Code's is a var(--vscode-…, fallback): given to a
      // canvas as it is, it is no colour, and the grid painted black.
      for (const [field, value] of Object.entries(theme)) {
        expect([mode, field, String(value)]).not.toEqual([mode, field, expect.stringMatching(/\bvar\(|color-mix\(/)]);
      }
      expect(theme.background).not.toBe('');
    }
    root.remove();
  });

  it('keeps a variant with plain colours as it gives them', async () => {
    const root = document.createElement('div');
    const theme = await variantTheme('datalayer', root, 'light');
    expect(String(theme.background)).toMatch(/^#|^rgb/);
  });

  it('takes the editor’s own variable when the page sets it, its fallback when not', () => {
    const vars: Record<string, string> = { '--vscode-editor-background': '#112233' };
    expect(withoutVariables('var(--vscode-editor-background, #1F1F1F)', (n) => vars[n])).toBe('#112233');
    expect(withoutVariables('var(--vscode-sideBar-background, #181818)', (n) => vars[n])).toBe('#181818');
    expect(withoutVariables('var(--a, var(--vscode-editor-background, #000))', (n) => vars[n])).toBe('#112233');
  });
});
