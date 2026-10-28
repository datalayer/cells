/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Where charts live on screen (§3.12): each chart of the sheet shown is a
 * DOM element above the grid canvas, positioned from the axes' offsets
 * inside the clip of the pane its anchor sits in, so a frozen pane clips a
 * chart scrolled under it and the canvas's blits never repaint a chart.
 * Only charts within one viewport of the pane mount their drawing; the
 * others keep their frame, their name and their place.
 *
 * @module react/ChartsLayer
 */

import { useCallback, useSyncExternalStore } from 'react';
import { chartRendererOf, resolveChart } from '../core/chartOption.js';
import { chartRect, type ChartSpec } from '../core/charts.js';
import type { CellsModel } from '../core/model.js';
import type { Sheet } from '../core/workbook.js';
import type { CellsTheme } from '../render/theme.js';
import type { Pane, Viewport } from '../render/viewport.js';
import { ChartFrame } from './ChartFrame.js';

export interface ChartsLayerProps {
  readonly model: CellsModel;
  readonly sheet: string;
  readonly viewport: Viewport;
  readonly theme: CellsTheme;
  readonly selectedChart?: string | null;
  readonly onPointerDownChart?: (id: string, event: React.PointerEvent) => void;
  /** The keys of a focused chart frame (arrows, Delete, Escape): `true` when handled. */
  readonly onChartKeyDown?: (event: React.KeyboardEvent) => boolean;
}

/** The pane a chart's anchor sits in: by its anchor cell, or its px against the frozen extents. */
export function paneOfChart(sheet: Sheet, spec: ChartSpec, panes: readonly Pane[]): Pane {
  const a = spec.anchor;
  let inFrozenRows: boolean;
  let inFrozenCols: boolean;
  if (a.kind === 'absolute') {
    inFrozenRows = sheet.frozen.rows > 0 && a.y < sheet.rows.offsetOf(sheet.frozen.rows);
    inFrozenCols = sheet.frozen.cols > 0 && a.x < sheet.cols.offsetOf(sheet.frozen.cols);
  } else {
    inFrozenRows = a.from.row < sheet.frozen.rows;
    inFrozenCols = a.from.col < sheet.frozen.cols;
  }
  const name =
    inFrozenRows && inFrozenCols ? 'corner' : inFrozenRows ? 'top' : inFrozenCols ? 'left' : 'main';
  return panes.find((p) => p.name === name) ?? panes.find((p) => p.name === 'main')!;
}

/** A chart's rectangle in a pane, view px relative to the pane's corner, and whether it is within one viewport of it. */
export function placeChart(
  sheet: Sheet,
  spec: ChartSpec,
  pane: Pane,
  zoom: number,
): { x: number; y: number; width: number; height: number; near: boolean } {
  const r = chartRect(sheet, spec);
  const x = (r.x - pane.originX) * zoom;
  const y = (r.y - pane.originY) * zoom;
  const width = Math.max(1, Math.round(r.width * zoom));
  const height = Math.max(1, Math.round(r.height * zoom));
  const near =
    x + width >= -pane.width &&
    x <= 2 * pane.width &&
    y + height >= -pane.height &&
    y <= 2 * pane.height;
  return { x: Math.round(x), y: Math.round(y), width, height, near };
}

export function ChartsLayer(props: ChartsLayerProps) {
  const { model, viewport, theme } = props;
  const subscribe = useCallback((notify: () => void) => model.subscribe(notify), [model]);
  useSyncExternalStore(
    subscribe,
    () => model.revision,
    () => model.revision,
  );
  const subscribePlatform = useCallback(
    (notify: () => void) => model.reactor.subscribe(notify),
    [model],
  );
  useSyncExternalStore(
    subscribePlatform,
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
  if (!model.workbook.hasSheet(props.sheet)) return null;
  const sheet = model.sheet(props.sheet);
  if (sheet.charts.size === 0) return null;
  const renderer = chartRendererOf(model.reactor);
  const loaded = renderer === undefined ? 'not-loaded' : 'loaded';
  const byPane = new Map<Pane, ChartSpec[]>();
  for (const spec of sheet.charts.values()) {
    const pane = paneOfChart(sheet, spec, viewport.panes);
    let list = byPane.get(pane);
    if (list === undefined) byPane.set(pane, (list = []));
    list.push(spec);
  }
  return (
    <>
      {[...byPane].map(([pane, specs]) => (
        <div
          key={pane.name}
          data-cells-charts-pane={pane.name}
          style={{
            position: 'absolute',
            left: pane.x,
            top: pane.y,
            width: pane.width,
            height: pane.height,
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          {specs.map((spec) => {
            const place = placeChart(sheet, spec, pane, viewport.zoom);
            const resolved = place.near
              ? resolveChart(model, sheet.id, spec.id, theme, loaded)
              : null;
            return (
              <div
                key={spec.id}
                style={{
                  position: 'absolute',
                  left: place.x,
                  top: place.y,
                  width: place.width,
                  height: place.height,
                  pointerEvents: 'auto',
                }}
                onPointerDown={(e) => props.onPointerDownChart?.(spec.id, e)}
                onKeyDown={(e) => {
                  if (props.onChartKeyDown?.(e)) e.stopPropagation();
                }}
              >
                <ChartFrame
                  spec={spec}
                  resolved={
                    resolved ?? { kind: 'placeholder', text: `A ${spec.type} chart, off screen` }
                  }
                  renderer={renderer}
                  width={place.width}
                  height={place.height}
                  theme={theme}
                  mounted={place.near}
                  selected={props.selectedChart === spec.id}
                  focusWhenSelected
                />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
