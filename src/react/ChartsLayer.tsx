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

import { useCallback, useRef, useSyncExternalStore } from 'react';
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

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

interface Drag {
  readonly id: string;
  readonly handle: Handle | 'move';
  readonly startX: number;
  readonly startY: number;
  readonly pointerId: number;
  /** The frame's sheet px at the start. */
  readonly rect: { x: number; y: number; width: number; height: number };
}

/**
 * A drag's end as commands: a move of the frame, or a resize by one of its
 * eight handles (a corner or edge on the frame's left or top moves the
 * chart too). The delta is in sheet px; with Alt the frame snaps to the
 * cell edges, else it keeps its offsets inside the cells.
 */
export function dragCommands(
  sheet: Sheet,
  spec: ChartSpec,
  drag: Drag,
  dx: number,
  dy: number,
  snap: boolean,
): {
  move?: { row: number; col: number } | { x: number; y: number };
  resize?: { row: number; col: number } | { width: number; height: number };
} {
  const r = drag.rect;
  const h = drag.handle;
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.width;
  let y1 = r.y + r.height;
  if (h === 'move') {
    // Clamped at the sheet's edge, the frame keeps its size.
    x0 = Math.max(0, x0 + dx);
    y0 = Math.max(0, y0 + dy);
    x1 = x0 + r.width;
    y1 = y0 + r.height;
  } else {
    if (h.includes('w')) x0 = Math.min(x0 + dx, x1 - 16);
    if (h.includes('e')) x1 = Math.max(x1 + dx, x0 + 16);
    if (h.includes('n')) y0 = Math.min(y0 + dy, y1 - 16);
    if (h.includes('s')) y1 = Math.max(y1 + dy, y0 + 16);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  const a = spec.anchor;
  if (a.kind === 'absolute') {
    const out: ReturnType<typeof dragCommands> = {};
    if (x0 !== r.x || y0 !== r.y) out.move = { x: Math.round(x0), y: Math.round(y0) };
    if (x1 - x0 !== r.width || y1 - y0 !== r.height)
      out.resize = { width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    return out;
  }
  const col0 = Math.min(sheet.cols.indexAt(x0), sheet.cols.count - 1);
  const row0 = Math.min(sheet.rows.indexAt(y0), sheet.rows.count - 1);
  const out: ReturnType<typeof dragCommands> = {};
  if (col0 !== a.from.col || row0 !== a.from.row || h === 'move')
    out.move = { row: row0, col: col0 };
  if (a.kind === 'cells') {
    const col1 = Math.max(col0, Math.min(sheet.cols.indexAt(x1), sheet.cols.count - 1));
    const row1 = Math.max(row0, Math.min(sheet.rows.indexAt(y1), sheet.rows.count - 1));
    if (h !== 'move') out.resize = { row: row1, col: col1 };
  } else if (h !== 'move') out.resize = { width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  void snap;
  return out;
}

export function ChartsLayer(props: ChartsLayerProps) {
  const { model, viewport, theme } = props;
  const drag = useRef<Drag | null>(null);
  const endDrag = (e: React.PointerEvent, sheet: Sheet) => {
    const d = drag.current;
    drag.current = null;
    if (d === null) return;
    const spec = sheet.charts.get(d.id);
    if (spec === undefined) return;
    const dx = (e.clientX - d.startX) / viewport.zoom;
    const dy = (e.clientY - d.startY) / viewport.zoom;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const c = dragCommands(sheet, spec, d, dx, dy, e.altKey);
    const run = () => {
      if (c.move !== undefined)
        model.dispatch({ type: 'MOVE_CHART', sheet: sheet.id, id: d.id, to: c.move });
      if (c.resize !== undefined)
        model.dispatch({ type: 'RESIZE_CHART', sheet: sheet.id, id: d.id, to: c.resize });
    };
    if (c.move !== undefined && c.resize !== undefined)
      model.transact(d.handle === 'move' ? 'Move chart' : 'Resize chart', run);
    else run();
  };
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
                data-cells-chart-holder=""
                style={{
                  position: 'absolute',
                  left: place.x,
                  top: place.y,
                  width: place.width,
                  height: place.height,
                  pointerEvents: 'auto',
                }}
                onPointerDown={(e) => {
                  props.onPointerDownChart?.(spec.id, e);
                  const handle = (e.target as HTMLElement).getAttribute('data-cells-chart-handle');
                  if (e.button !== 0) return;
                  const rect = chartRect(sheet, spec);
                  drag.current = {
                    id: spec.id,
                    handle: (handle as Handle | null) ?? 'move',
                    startX: e.clientX,
                    startY: e.clientY,
                    pointerId: e.pointerId,
                    rect,
                  };
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                }}
                onPointerUp={(e) => endDrag(e, sheet)}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  if (props.onChartKeyDown?.(e)) e.stopPropagation();
                }}
              >
                {props.selectedChart === spec.id &&
                  HANDLES.map((h) => (
                    <div
                      key={h}
                      data-cells-chart-handle={h}
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        width: 8,
                        height: 8,
                        background: theme.selectionBorder,
                        border: `1px solid ${theme.background}`,
                        boxSizing: 'border-box',
                        zIndex: 2,
                        cursor: `${h}-resize`,
                        left: h.includes('w')
                          ? -4
                          : h.includes('e')
                            ? place.width - 4
                            : place.width / 2 - 4,
                        top: h.includes('n')
                          ? -4
                          : h.includes('s')
                            ? place.height - 4
                            : place.height / 2 - 4,
                      }}
                    />
                  ))}
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
