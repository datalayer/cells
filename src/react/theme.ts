/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Resolving the `CellsTheme` the canvas needs from what a host has: its
 * Primer CSS variables (`theme="auto"`), a primer-addons variant
 * (`theme="loop"`, through `exportPortableTheme`, loaded only when asked
 * for), or a `CellsTheme` object. Under `forced-colors: active` the system
 * colours win.
 *
 * @module react/theme
 */

import {
  type CellsTheme,
  checkTheme,
  DARK_THEME,
  FORCED_COLORS_THEME,
  LIGHT_THEME,
} from '../render/theme.js';

export type ColorMode = 'light' | 'dark' | 'auto';

/** Which CellsTheme field reads which Primer variable. */
export const PRIMER_VARIABLES: Readonly<Partial<Record<keyof CellsTheme, `--${string}`>>> = {
  background: '--bgColor-default',
  text: '--fgColor-default',
  textMuted: '--fgColor-muted',
  gridline: '--borderColor-muted',
  headerBackground: '--bgColor-muted',
  headerText: '--fgColor-muted',
  headerBorder: '--borderColor-default',
  headerSelectedBackground: '--bgColor-accent-muted',
  selectionFill: '--bgColor-accent-muted',
  selectionBorder: '--borderColor-accent-emphasis',
  activeCellBorder: '--borderColor-accent-emphasis',
  fillHandle: '--borderColor-accent-emphasis',
  copyMarch: '--borderColor-accent-emphasis',
  errorText: '--fgColor-danger',
  linkText: '--fgColor-accent',
  fontFamily: '--fontStack-sansSerif',
};

/** A theme from variables, over Primer's light or dark defaults for what is not set. */
export function themeFromVariables(
  read: (name: `--${string}`) => string | undefined,
  dark: boolean,
): CellsTheme {
  const base = dark ? DARK_THEME : LIGHT_THEME;
  const out: Record<string, unknown> = { ...base };
  for (const [field, variable] of Object.entries(PRIMER_VARIABLES)) {
    const value = read(variable!)?.trim();
    if (value) out[field] = value;
  }
  checkTheme(out);
  return out;
}

/** Whether the host shows dark: the nearest `data-color-mode`, else the system. */
export function isDark(element: Element, colorMode: ColorMode): boolean {
  if (colorMode !== 'auto') return colorMode === 'dark';
  const host = element.closest('[data-color-mode]');
  const mode = host?.getAttribute('data-color-mode');
  if (mode === 'dark' || mode === 'light') return mode === 'dark';
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function forcedColors(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(forced-colors: active)').matches;
}

/** The theme `auto` resolves to: the variables set on the element's ancestors. */
export function autoTheme(element: Element, colorMode: ColorMode): CellsTheme {
  if (forcedColors()) return FORCED_COLORS_THEME;
  const style = getComputedStyle(element);
  return themeFromVariables(
    (name) => style.getPropertyValue(name) || undefined,
    isDark(element, colorMode),
  );
}

/** A primer-addons variant's theme: its portable token map for the mode. Loads primer-addons when first asked. */
export async function variantTheme(
  variant: string,
  element: Element,
  colorMode: ColorMode,
): Promise<CellsTheme> {
  if (forcedColors()) return FORCED_COLORS_THEME;
  let portable: {
    themeVariants: readonly string[];
    exportPortableTheme(v: string): {
      modes: { light: Record<string, string>; dark: Record<string, string> };
    };
  };
  try {
    portable = (await import('@datalayer/primer-addons/lib/theme/portable')) as never;
  } catch (error) {
    throw new Error(
      `theme="${variant}" needs @datalayer/primer-addons (an optional peer of @datalayer/cells), which could not be loaded: ${(error as Error).message}`,
    );
  }
  if (!portable.themeVariants.includes(variant)) {
    throw new Error(
      `No primer-addons theme '${variant}'; there are ${portable.themeVariants.join(', ')}.`,
    );
  }
  const dark = isDark(element, colorMode);
  const map = portable.exportPortableTheme(variant).modes[dark ? 'dark' : 'light'];
  return themeFromVariables((name) => {
    const value = map[name];
    return value && needsTheBrowser(value)
      ? resolvedInPage(value, element, name === PRIMER_VARIABLES.fontFamily)
      : value;
  }, dark);
}

/**
 * Whether a token is a CSS expression rather than a value a canvas reads:
 * a `var(…)` (the VS Code variant's every token, its editor's variable with
 * Light or Dark Modern behind it) or a `color-mix(…)`. Given to a canvas as
 * it is, it is no colour, and the canvas paints black.
 */
const needsTheBrowser = (value: string): boolean => /\b(?:var|color-mix|calc)\(/.test(value);

/**
 * A token as it applies where the grid is: every `var(--name, fallback)` in
 * it replaced by the variable's value on the grid's ancestors (inside VS
 * Code, the editor's own colour), else by its fallback (Light or Dark
 * Modern elsewhere); then, when what is left is still an expression (a
 * `color-mix(…)`), as the browser computes it on a probe in the grid.
 */
function resolvedInPage(value: string, element: Element, font: boolean): string | undefined {
  const style = getComputedStyle(element);
  const plain = withoutVariables(value, (name) => style.getPropertyValue(name).trim() || undefined);
  if (!needsTheBrowser(plain)) return plain || undefined;
  const probe = element.ownerDocument.createElement('span');
  probe.style.display = 'none';
  if (font) {
    probe.style.fontFamily = plain;
  } else {
    probe.style.color = plain;
  }
  element.appendChild(probe);
  try {
    const computed = getComputedStyle(probe);
    const resolved = (font ? computed.fontFamily : computed.color).trim();
    return resolved && !needsTheBrowser(resolved) ? resolved : undefined;
  } finally {
    probe.remove();
  }
}

/** A value with each `var(--name[, fallback])` replaced, innermost first; a variable unset and without fallback leaves nothing. */
export function withoutVariables(value: string, read: (name: string) => string | undefined): string {
  let out = value;
  for (let guard = 0; guard < 32 && out.includes('var('); guard++) {
    const start = out.lastIndexOf('var(');
    let depth = 0;
    let end = start + 4;
    for (; end < out.length; end++) {
      if (out[end] === '(') depth++;
      else if (out[end] === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    const inner = out.slice(start + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    out = out.slice(0, start) + (read(name) ?? fallback) + out.slice(end + 1);
  }
  return out;
}
