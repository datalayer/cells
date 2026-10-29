/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The grid's scrollbars show and work: on the million rows page, in light and
 * dark, the scroller keeps a gutter the canvases leave free, its thumbs are
 * painted in the theme's colours, dragging the vertical thumb to the end
 * reaches the last rows (the thumb maps to the whole sheet above the 8 M px
 * spacer), and clicking a track pages the grid without selecting a cell.
 */

const SCHEMES = ['light', 'dark'] as const;

// Playwright's headless Chrome hides scrollbars (--hide-scrollbars); this suite shows them, as a
// headed browser does.
test.use({
  launchOptions: {
    executablePath: process.env.CELLS_CHROME ?? '/usr/bin/google-chrome',
    args: ['--js-flags=--max-old-space-size=2048'],
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

interface Gutter {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  overflowX: string;
  overflowY: string;
}

async function gutterOf(scroller: Locator): Promise<Gutter> {
  return scroller.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: el.offsetWidth - el.clientWidth,
      bottom: el.offsetHeight - el.clientHeight,
      overflowX: s.overflowX,
      overflowY: s.overflowY,
    };
  });
}

/** The thumb along a scrollbar: the run of pixels far from the track's colour, page px. */
async function thumbOf(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  vertical: boolean,
): Promise<{ start: number; end: number } | null> {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(
    async ({ png, vertical, origin }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const n = vertical ? img.height : img.width;
      const at = (i: number) =>
        vertical
          ? g.getImageData(Math.floor(img.width / 2), i, 1, 1).data
          : g.getImageData(i, Math.floor(img.height / 2), 1, 1).data;
      // The track's colour: the commonest along the line.
      const counts = new Map<string, number>();
      const px: number[][] = [];
      for (let i = 0; i < n; i++) {
        const d = at(i);
        px.push([d[0], d[1], d[2]]);
        const k = `${d[0]},${d[1]},${d[2]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const track = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])[0][0]
        .split(',')
        .map(Number);
      const far = (p: number[]) =>
        Math.abs(p[0] - track[0]) + Math.abs(p[1] - track[1]) + Math.abs(p[2] - track[2]) > 60;
      // The longest run of far pixels (arrow buttons, when drawn, are short glyphs).
      let best: { start: number; end: number } | null = null;
      let start = -1;
      for (let i = 0; i <= n; i++) {
        if (i < n && far(px[i])) {
          if (start < 0) start = i;
        } else if (start >= 0) {
          if (best === null || i - start > best.end - best.start) best = { start, end: i };
          start = -1;
        }
      }
      return best && { start: best.start + origin, end: best.end + origin };
    },
    { png, vertical, origin: vertical ? clip.y : clip.x },
  );
}

/** The first and last sheet rows the accessibility mirror holds (what shows, and the active cell's row). */
async function rowsShown(grid: Locator): Promise<[number, number]> {
  return grid.evaluate((el) => {
    const rows = [...el.querySelectorAll('[data-cells-mirror] [role="row"][aria-rowindex]')]
      .map((r) => Number(r.getAttribute('aria-rowindex')))
      .filter((n) => n > 1);
    return [Math.min(...rows), Math.max(...rows)] as [number, number];
  });
}

for (const scheme of SCHEMES) {
  test(`the million rows show usable scrollbars in ${scheme}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/#/large');
    await page.getByRole('button', { name: /Load 11 columns/ }).click();
    const grid = page.getByRole('grid', { name: 'A million rows' });
    await grid.waitFor({ timeout: 200_000 });
    const scroller = grid.locator('[data-cells-scroller]');
    await expect.poll(async () => (await gutterOf(scroller)).height).toBeGreaterThan(100);
    const g = await gutterOf(scroller);
    expect(g.overflowY).toBe('scroll');
    expect(g.overflowX).toBe('scroll');
    // Chrome on Linux draws classic scrollbars, which keep a gutter.
    expect(g.right).toBeGreaterThan(0);
    expect(g.bottom).toBeGreaterThan(0);

    // Nothing covers the scrollbars: the scroller is what the pointer meets on them.
    const vx = g.left + g.width - g.right / 2;
    const hy = g.top + g.height - g.bottom / 2;
    const hit = (x: number, y: number) =>
      page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-cells-scroller'),
        { x, y },
      );
    expect(await hit(vx, g.top + g.height / 2)).toBe(true);
    expect(await hit(g.left + g.width / 2, hy)).toBe(true);

    // The canvases end where the scrollbars start.
    const canvas = await grid.locator('canvas').first().boundingBox();
    expect(Math.round(canvas!.x + canvas!.width)).toBeLessThanOrEqual(
      Math.round(g.left + g.width - g.right),
    );
    expect(Math.round(canvas!.y + canvas!.height)).toBeLessThanOrEqual(
      Math.round(g.top + g.height - g.bottom),
    );

    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('main').screenshot({ path: testInfo.outputPath(`large-${scheme}.png`) });

    // The thumbs are painted: a run of thumb-coloured pixels along each track.
    const vTrack = {
      x: Math.floor(g.left + g.width - g.right),
      y: Math.floor(g.top),
      width: Math.floor(g.right),
      height: Math.floor(g.height - g.bottom),
    };
    const hTrack = {
      x: Math.floor(g.left),
      y: Math.floor(g.top + g.height - g.bottom),
      width: Math.floor(g.width - g.right),
      height: Math.floor(g.bottom),
    };
    const vThumb = await thumbOf(page, vTrack, true);
    const hThumb = await thumbOf(page, hTrack, false);
    expect(vThumb, 'the vertical thumb shows').not.toBeNull();
    expect(hThumb, 'the horizontal thumb shows').not.toBeNull();
    expect(vThumb!.end - vThumb!.start).toBeGreaterThan(8);
    expect(hThumb!.end - hThumb!.start).toBeGreaterThan(8);

    // Clicking the horizontal track past the thumb pages right, and selects nothing.
    await grid.click({ position: { x: 118, y: 35 } });
    const active = await grid.getAttribute('aria-activedescendant');
    await page.mouse.click(hTrack.x + hTrack.width - 30, hy);
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await grid.getAttribute('aria-activedescendant')).toBe(active);

    // Clicking the vertical track below the thumb pages down.
    const before = (await rowsShown(grid))[1];
    await page.mouse.click(vx, vTrack.y + vTrack.height - 30);
    await expect.poll(async () => (await rowsShown(grid))[1]).toBeGreaterThan(before + 10);
    expect(await grid.getAttribute('aria-activedescendant')).toBe(active);

    // Dragging the thumb to the bottom reaches the millionth row (the scaled mapping).
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect.poll(async () => (await rowsShown(grid))[1]).toBeLessThanOrEqual(before);
    const top = (await thumbOf(page, vTrack, true))!;
    await page.mouse.move(vx, (top.start + top.end) / 2);
    await page.mouse.down();
    await page.mouse.move(vx, vTrack.y + vTrack.height / 2, { steps: 5 });
    await expect.poll(async () => (await rowsShown(grid))[1]).toBeGreaterThan(400_000);
    await page.mouse.move(vx, vTrack.y + vTrack.height + 40, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await rowsShown(grid))[1]).toBeGreaterThan(999_000);
    expect(await grid.getAttribute('aria-activedescendant')).toBe(active);
  });
}
