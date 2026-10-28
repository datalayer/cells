/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The output frames of code cells (§3.13, C11-05), and *Open in editor*:
 * DOM over the canvas, as the charts' frames are. A frame sits beside its
 * cell (its top-left at the cell's top-right corner), clipped by its pane,
 * moved by the same scroll, mounted only within one viewport of the visible
 * area and at most {@link CODE_FRAMES_CAP} at once; it draws the cell's
 * stored outputs through the `datalayer.cells.codeRenderer` contribution
 * (jupyter-react's `Output` from `./jupyter`), statically, so scrolling and
 * remounting never run anything; with no renderer, the `text/plain` of the
 * outputs. Each is `role="region"`, "Output of B4", reached by *Go to
 * output*; Escape returns to the cell.
 *
 * @module react/CodeLayer
 */

import {
  createElement,
  type ComponentType,
  useCallback,
  useState,
  useSyncExternalStore,
} from 'react';
import { type CodeCell, codeCells, codeFrame, codeRef, type CodeOutput } from '../core/code.js';
import { codeRendererOf } from '../core/codeRun.js';
import type { CellsModel } from '../core/model.js';
import type { Sheet } from '../core/workbook.js';
import type { CodeEditorRendererProps, CodeOutputRendererProps } from '../points/index.js';
import type { CellsTheme } from '../render/theme.js';
import type { Pane, Viewport } from '../render/viewport.js';

/** The most output frames mounted at once; the nearest to the view win. */
export const CODE_FRAMES_CAP = 20;

/** Outputs over this many bytes render on demand, behind *Show output*. */
export const CODE_OUTPUT_LAZY_BYTES = 200_000;

/** The props of `<CodeLayer>`. */
export interface CodeLayerProps {
  readonly model: CellsModel;
  readonly sheet: string;
  readonly viewport: Viewport;
  readonly theme: CellsTheme;
  /** The code cell being edited in the contributed editor, if any. */
  readonly editing?: { readonly row: number; readonly col: number } | null;
  readonly onCloseEditor?: () => void;
  /** Escape in a frame: back to the grid. */
  readonly onEscape?: () => void;
}

/** The `text/plain` of a code cell's outputs, as the fallback frame and the frame's description show it. */
export function outputsText(outputs: readonly CodeOutput[]): string {
  const parts: string[] = [];
  for (const o of outputs) {
    if (o.output_type === 'stream') parts.push(String((o as { text?: unknown }).text ?? ''));
    else if (o.output_type === 'error')
      parts.push(`${String(o.ename ?? 'Error')}: ${String(o.evalue ?? '')}`);
    else {
      const text = ((o as { data?: Record<string, unknown> }).data ?? {})['text/plain'];
      if (text !== undefined) parts.push(Array.isArray(text) ? text.join('') : String(text));
    }
  }
  return parts.join('\n').trim();
}

/** The pane a cell sits in: by the frozen extents. */
export function paneOfCell(sheet: Sheet, row: number, col: number, panes: readonly Pane[]): Pane {
  const inRows = row < sheet.frozen.rows;
  const inCols = col < sheet.frozen.cols;
  const name = inRows && inCols ? 'corner' : inRows ? 'top' : inCols ? 'left' : 'main';
  return panes.find((p) => p.name === name) ?? panes.find((p) => p.name === 'main')!;
}

/** Where a code cell's frame goes in a pane: view px from the pane's corner, and whether it is within one viewport. */
export function placeFrame(
  sheet: Sheet,
  row: number,
  col: number,
  frame: { readonly width: number; readonly height: number },
  pane: Pane,
  zoom: number,
): { x: number; y: number; width: number; height: number; near: boolean; distance: number } {
  const sx = sheet.cols.offsetOf(col) + sheet.cols.effectiveSizeOf(col);
  const sy = sheet.rows.offsetOf(row);
  const x = Math.round((sx - pane.originX) * zoom);
  const y = Math.round((sy - pane.originY) * zoom);
  const width = Math.max(1, Math.round(frame.width * zoom));
  const height = Math.max(1, Math.round(frame.height * zoom));
  const near =
    x + width >= -pane.width &&
    x <= 2 * pane.width &&
    y + height >= -pane.height &&
    y <= 2 * pane.height;
  const distance = Math.hypot(
    Math.max(0, -x, x + width - pane.width),
    Math.max(0, -y, y + height - pane.height),
  );
  return { x, y, width, height, near, distance };
}

/** The approximate size of outputs, bytes. */
const bytesOf = (outputs: readonly CodeOutput[]) => JSON.stringify(outputs).length;

function Frame(props: {
  readonly model: CellsModel;
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  readonly code: CodeCell;
  readonly place: ReturnType<typeof placeFrame>;
  readonly theme: CellsTheme;
  readonly renderer: ComponentType<CodeOutputRendererProps> | undefined;
  readonly mounted: boolean;
  readonly onEscape?: () => void;
}) {
  const { code, place, theme } = props;
  const ref = codeRef(props.row, props.col);
  const heavy = bytesOf(code.outputs) > CODE_OUTPUT_LAZY_BYTES;
  const shown = useSyncExternalStore(
    useCallback((notify: () => void) => props.model.subscribe(notify), [props.model]),
    () => props.model.codeState(props.sheet, props.row, props.col) !== 'running',
    () => true,
  );
  const text = outputsText(code.outputs);
  return (
    <div
      data-cells-code-output={ref}
      role="region"
      aria-label={`Output of ${ref}`}
      aria-description={text.slice(0, 500) || undefined}
      tabIndex={-1}
      style={{
        position: 'absolute',
        left: place.x,
        top: place.y,
        width: place.width,
        height: place.height,
        overflow: 'auto',
        boxSizing: 'border-box',
        border: `1px solid ${theme.gridline}`,
        background: theme.background,
        color: theme.text,
        pointerEvents: 'auto',
        font: `${theme.fontSize}px ${theme.fontFamily}`,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onEscape?.();
        }
      }}
    >
      {props.mounted && shown && (
        <LazyOutputs
          heavy={heavy}
          renderer={props.renderer}
          outputs={code.outputs}
          cell={ref}
          width={place.width}
          height={place.height}
          text={text}
        />
      )}
    </div>
  );
}

function LazyOutputs(props: {
  readonly heavy: boolean;
  readonly renderer: ComponentType<CodeOutputRendererProps> | undefined;
  readonly outputs: readonly CodeOutput[];
  readonly cell: string;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}) {
  const [wanted, setWanted] = useState(false);
  if (props.heavy && !wanted)
    return (
      <button type="button" onClick={() => setWanted(true)} style={{ margin: 8 }}>
        Show output ({Math.round(bytesOf(props.outputs) / 1024)} kB)
      </button>
    );
  if (props.renderer === undefined)
    return (
      <pre style={{ margin: 8, whiteSpace: 'pre-wrap', font: 'inherit' }} data-cells-code-text="">
        {props.text}
      </pre>
    );
  return createElement(props.renderer, {
    outputs: props.outputs,
    cell: props.cell,
    width: props.width,
    height: props.height,
  });
}

/** The output frames of a sheet's code cells, per pane, and the editor over the cell being edited. */
export function CodeLayer(props: CodeLayerProps) {
  const { model, viewport, theme } = props;
  useSyncExternalStore(
    useCallback((notify: () => void) => model.subscribe(notify), [model]),
    () => model.revision,
    () => model.revision,
  );
  useSyncExternalStore(
    useCallback((notify: () => void) => model.reactor.subscribe(notify), [model]),
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
  if (!model.workbook.hasSheet(props.sheet)) return null;
  const sheet = model.sheet(props.sheet);
  if (sheet.code.size === 0) return null;
  const renderer = codeRendererOf(model.reactor)?.value;
  const Output = renderer?.output as ComponentType<CodeOutputRendererProps> | undefined;
  const Editor = renderer?.editor as ComponentType<CodeEditorRendererProps> | undefined;
  type Placed = {
    row: number;
    col: number;
    code: CodeCell;
    pane: Pane;
    place: ReturnType<typeof placeFrame>;
  };
  const placed: Placed[] = [];
  for (const c of codeCells(sheet)) {
    const frame = codeFrame(c.code);
    if (frame === undefined) continue;
    const pane = paneOfCell(sheet, c.row, c.col, viewport.panes);
    placed.push({ ...c, pane, place: placeFrame(sheet, c.row, c.col, frame, pane, viewport.zoom) });
  }
  // Mounted: the nearest to the view, up to the cap; the others keep their frame and name.
  const mounted = new Set(
    placed
      .filter((p) => p.place.near)
      .sort((a, b) => a.place.distance - b.place.distance)
      .slice(0, CODE_FRAMES_CAP),
  );
  const byPane = new Map<Pane, Placed[]>();
  for (const p of placed) {
    let list = byPane.get(p.pane);
    if (list === undefined) byPane.set(p.pane, (list = []));
    list.push(p);
  }
  const editing = props.editing ?? null;
  return (
    <>
      {[...byPane].map(([pane, list]) => (
        <div
          key={pane.name}
          data-cells-code-pane={pane.name}
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
          {list.map((p) => (
            <Frame
              key={`${p.row},${p.col}`}
              model={model}
              sheet={sheet.id}
              row={p.row}
              col={p.col}
              code={p.code}
              place={p.place}
              theme={theme}
              renderer={Output}
              mounted={mounted.has(p)}
              onEscape={props.onEscape}
            />
          ))}
        </div>
      ))}
      {editing !== null && model.code(sheet.id, editing.row, editing.col) !== undefined && (
        <div
          data-cells-code-editor-holder=""
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(0, 0, 0, 0.2)',
            overflow: 'auto',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              props.onCloseEditor?.();
            }
          }}
        >
          <div
            style={{
              background: theme.background,
              color: theme.text,
              border: `1px solid ${theme.gridline}`,
              borderRadius: 6,
              minWidth: 320,
              maxWidth: '100%',
              padding: 8,
              pointerEvents: 'auto',
            }}
          >
            {Editor !== undefined ? (
              createElement(Editor, {
                sheet: sheet.id,
                row: editing.row,
                col: editing.col,
                model,
                onClose: () => props.onCloseEditor?.(),
              })
            ) : (
              <PlainEditor
                model={model}
                sheet={sheet.id}
                row={editing.row}
                col={editing.col}
                onClose={() => props.onCloseEditor?.()}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The editor with no renderer contributed: a textarea over the source, *Save* writes it back as one undo step. */
export function PlainEditor({ model, sheet, row, col, onClose }: CodeEditorRendererProps) {
  const m = model as CellsModel;
  const code = m.code(sheet, row, col);
  const [text, setText] = useState(code?.source ?? '');
  if (code === undefined) return null;
  const save = () => {
    if (text !== code.source)
      m.dispatch({ type: 'SET_CODE', sheet, row, col, code: { ...code, source: text } });
    onClose();
  };
  return (
    <div role="dialog" aria-label={`Code of ${codeRef(row, col)}`} data-cells-code-editor="">
      <textarea
        aria-label="Source"
        value={text}
        rows={Math.min(20, Math.max(4, text.split('\n').length + 1))}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button type="button" onClick={save}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
