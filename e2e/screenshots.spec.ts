/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * C7-04: the chrome (toolbar, formula bar with its name box, the grid, sheet
 * tabs, the context menu) in two themes: axe finds no violation in either, and
 * the screenshots match the suite's. The screenshots are compared on CI's
 * Chrome only (`e2e/__screenshots__`, written by CI's own run, since fonts and
 * rasterisation differ between machines); elsewhere their comparison skips.
 */

const SCHEMES = ['light', 'dark'] as const;

/** Open the chrome page in a colour scheme (the examples' appearance follows the system's). */
async function open(page: Page, scheme: (typeof SCHEMES)[number]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/#/chrome');
  const grid = page.getByRole('grid', { name: 'Budget' });
  await grid.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction((dark) => {
    const rgb = getComputedStyle(document.querySelector('main')!).color.match(/\d+/g)!;
    const light = Number(rgb[0]) > 150;
    return light === dark && document.getAnimations().every((a) => a.playState !== 'running');
  }, scheme === 'dark');
  return grid;
}

for (const scheme of SCHEMES) {
  test(`the chrome passes axe in ${scheme}`, async ({ page }) => {
    const grid = await open(page, scheme);
    const violations = async (when: string) =>
      (await new AxeBuilder({ page }).analyze()).violations.flatMap((v) =>
        v.nodes.map((n) => `${when}: ${v.id} ${n.target.join(' ')}: ${n.failureSummary}`),
      );
    expect(await violations(scheme)).toEqual([]);
    await grid.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Cell actions' })).toBeVisible();
    expect(await violations(`${scheme}, the context menu open`)).toEqual([]);
  });

  test(`the chrome matches its screenshots in ${scheme}`, async ({ page }) => {
    test.skip(!process.env.CI, "Screenshots are compared on CI's Chrome only.");
    const grid = await open(page, scheme);
    const main = page.getByRole('main');
    await expect(main).toHaveScreenshot(`chrome-${scheme}.png`, { maxDiffPixelRatio: 0.002 });
    await grid.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Cell actions' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveScreenshot(`chrome-menu-${scheme}.png`, { maxDiffPixelRatio: 0.002 });
  });
}
