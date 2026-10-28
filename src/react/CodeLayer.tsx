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

import { Overlay, ThemeProvider } from '@primer/react';
import {
  createElement,
  type ComponentType,
  Suspense,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { codeRunner } from '../core/codeRun.js';
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
  /** The code cell being edited in the overlay, if any, and where the overlay goes (view px of the grid's root). */
  readonly editing?: {
    readonly row: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
  } | null;
  readonly onCloseEditor?: () => void;
  /** The code cell whose outputs are previewed at the cell (a hover, Alt+Down), and where the preview goes. */
  readonly preview?: {
    readonly row: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
  } | null;
  readonly onClosePreview?: () => void;
  /** The pointer entered (`true`) or left (`false`) the preview: leaving closes it. */
  readonly onPreviewPointer?: (over: boolean) => void;
  /** The grid's portal root, where the overlay goes (as the context menu does). */
  readonly portalName?: string;
  /** The grid's focus target, which the overlay returns focus to. */
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
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

/** The mime types an untrusted output keeps: text and images, never HTML, scripts, SVG (scripts in it) or widgets. */
export const SAFE_MIMES = ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'text/latex'];

/**
 * Outputs as an untrusted frame shows them (§3.13, security): streams and
 * errors as they are, a display's safe mime types only; a display with none
 * left becomes a `text/plain` line saying what it held.
 */
export function safeOutputs(outputs: readonly CodeOutput[]): CodeOutput[] {
  return outputs.map((o) => {
    if (o.output_type === 'stream' || o.output_type === 'error') return o;
    const data = ((o as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    const kept = Object.fromEntries(
      Object.entries(data).filter(([mime]) => SAFE_MIMES.includes(mime)),
    );
    if (Object.keys(kept).length > 0) return { ...o, data: kept };
    const held = Object.keys(data).join(', ') || 'nothing';
    return { ...o, data: { 'text/plain': `[${held}: shown once the cell runs here]` } };
  });
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
  /** Whether the outputs were made here; an untrusted frame shows their text and images only. */
  readonly trusted: boolean;
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
  const outputs = props.trusted ? code.outputs : safeOutputs(code.outputs);
  const text = outputsText(outputs);
  const note = props.trusted
    ? ''
    : ' Untrusted: from a file or another person; HTML, scripts and widgets are shown once the cell runs here.';
  return (
    <div
      data-cells-code-output={ref}
      role="region"
      aria-label={`Output of ${ref}`}
      aria-description={`${text.slice(0, 500)}${note}`.trim() || undefined}
      data-cells-code-untrusted={props.trusted ? undefined : ''}
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
          outputs={outputs}
          trusted={props.trusted}
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
  readonly trusted: boolean;
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
  // A lazy renderer (the examples load jupyter-react on first use) shows its loading line meanwhile.
  return (
    <Suspense fallback={<span style={{ margin: 8 }}>Loading the output…</span>}>
      {createElement(props.renderer, {
        outputs: props.outputs,
        trusted: props.trusted,
        cell: props.cell,
        width: props.width,
        height: props.height,
      })}
    </Suspense>
  );
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
  const preview = props.preview ?? null;
  const previewed = preview === null ? undefined : model.code(sheet.id, preview.row, preview.col);
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
              trusted={model.codeTrusted(sheet.id, p.row, p.col)}
              onEscape={props.onEscape}
            />
          ))}
        </div>
      ))}
      {editing !== null && model.code(sheet.id, editing.row, editing.col) !== undefined && (
        <CodeEditorOverlay
          key={`${sheet.id}:${editing.row},${editing.col}`}
          model={model}
          sheet={sheet.id}
          row={editing.row}
          col={editing.col}
          x={editing.x}
          y={editing.y}
          width={Math.max(
            CODE_EDITOR_MIN_WIDTH,
            codeFrame(model.code(sheet.id, editing.row, editing.col)!)?.width ?? 0,
          )}
          editor={Editor}
          portalName={props.portalName}
          returnFocusRef={props.returnFocusRef}
          onClose={() => props.onCloseEditor?.()}
        />
      )}
      {preview !== null && previewed !== undefined && previewed.outputs.length > 0 && (
        <CodeOutputPreview
          key={`preview:${sheet.id}:${preview.row},${preview.col}`}
          cell={codeRef(preview.row, preview.col)}
          outputs={previewed.outputs}
          trusted={model.codeTrusted(sheet.id, preview.row, preview.col)}
          x={preview.x}
          y={preview.y}
          renderer={Output}
          theme={theme}
          portalName={props.portalName}
          returnFocusRef={props.returnFocusRef}
          onClose={() => props.onClosePreview?.()}
          onPointer={props.onPreviewPointer}
        />
      )}
    </>
  );
}

/** The preview's most size, px. */
export const CODE_PREVIEW_MAX = { width: 480, height: 360 } as const;

/** The props of `<CodeOutputPreview>`. */
export interface CodeOutputPreviewProps {
  readonly cell: string;
  readonly outputs: readonly CodeOutput[];
  readonly trusted: boolean;
  readonly x: number;
  readonly y: number;
  readonly renderer: ComponentType<CodeOutputRendererProps> | undefined;
  readonly theme: CellsTheme;
  readonly portalName?: string;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onPointer?: (over: boolean) => void;
}

/**
 * A code cell's outputs at the cell (§3.13): Primer's `Overlay` in the grid's
 * portal root, opened by a hover of 300 ms or Alt+Down, drawn by the
 * contributed renderer (untrusted outputs filtered as the frames are), up
 * to 480 × 360; closed when the pointer leaves the cell and the overlay, by
 * Escape, or by a click outside.
 */
export function CodeOutputPreview(props: CodeOutputPreviewProps) {
  const outputs = props.trusted ? props.outputs : safeOutputs(props.outputs);
  const text = outputsText(outputs);
  return (
    <ThemeProvider>
      <Overlay
        role="region"
        aria-label={`Output of ${props.cell}`}
        returnFocusRef={props.returnFocusRef as React.RefObject<HTMLElement>}
        onClickOutside={props.onClose}
        onEscape={props.onClose}
        portalContainerName={props.portalName}
        position="absolute"
        top={props.y}
        left={props.x}
        width="auto"
        preventFocusOnOpen
        style={{
          backgroundColor: 'var(--overlay-bgColor, Canvas)',
          color: 'var(--fgColor-default, CanvasText)',
          boxShadow:
            'var(--shadow-floating-small, 0 0 0 1px rgba(128, 128, 128, 0.35), 0 8px 24px rgba(0, 0, 0, 0.2))',
        }}
        data-cells-code-preview={props.cell}
      >
        <div
          data-cells-code-preview={props.cell}
          style={{
            maxWidth: CODE_PREVIEW_MAX.width,
            maxHeight: CODE_PREVIEW_MAX.height,
            overflow: 'auto',
            padding: 4,
            font: `${props.theme.fontSize}px ${props.theme.fontFamily}`,
          }}
          onPointerEnter={() => props.onPointer?.(true)}
          onPointerLeave={() => props.onPointer?.(false)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              props.onClose();
            }
          }}
        >
          <LazyOutputs
            heavy={false}
            renderer={props.renderer}
            outputs={outputs}
            trusted={props.trusted}
            cell={props.cell}
            width={CODE_PREVIEW_MAX.width - 8}
            height={CODE_PREVIEW_MAX.height - 8}
            text={text}
          />
        </div>
      </Overlay>
    </ThemeProvider>
  );
}

/** The overlay's least width, px (§3.13: 560 px at least, or the cell's frame when wider). */
export const CODE_EDITOR_MIN_WIDTH = 560;

/** The props of `<CodeEditorOverlay>`. */
export interface CodeEditorOverlayProps {
  readonly model: CellsModel;
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** Where the overlay's top-left goes, view px of the grid's root (the cell's bottom-left). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** The contributed editor (jupyter-react's `Cell`); the plain textarea without one. */
  readonly editor: ComponentType<CodeEditorRendererProps> | undefined;
  readonly portalName?: string;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

/**
 * *Open in editor* (§3.13, C11-06): Primer's `Overlay` in the grid's own
 * portal root, anchored at the cell, holding the contributed editor. Escape,
 * a click outside, *Save* and Ctrl+S save the source back (one undo step)
 * and close; Shift+Enter saves and runs the cell as the grid's run does.
 */
export function CodeEditorOverlay(props: CodeEditorOverlayProps) {
  const { model, sheet, row, col } = props;
  const controls = useRef<{ save: () => void } | null>(null);
  const closed = useRef(false);
  const save = () => controls.current?.save();
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    save();
    props.onClose();
  };
  const run = () => {
    save();
    void codeRunner(model)
      .run({ sheet, row, col })
      .catch(() => undefined);
  };
  const editorProps: CodeEditorRendererProps = {
    sheet,
    row,
    col,
    model,
    onClose: () => {
      closed.current = true;
      props.onClose();
    },
    register: (c) => {
      controls.current = c;
    },
  };
  return (
    <ThemeProvider>
      <Overlay
        role="dialog"
        aria-label={`Code of ${codeRef(row, col)}`}
        returnFocusRef={props.returnFocusRef as React.RefObject<HTMLElement>}
        onClickOutside={close}
        onEscape={close}
        portalContainerName={props.portalName}
        position="absolute"
        top={props.y}
        left={props.x}
        width="auto"
        style={{
          backgroundColor: 'var(--overlay-bgColor, Canvas)',
          color: 'var(--fgColor-default, CanvasText)',
          boxShadow:
            'var(--shadow-floating-small, 0 0 0 1px rgba(128, 128, 128, 0.35), 0 8px 24px rgba(0, 0, 0, 0.2))',
        }}
        data-cells-code-overlay=""
      >
        <div
          data-cells-code-overlay=""
          style={{ width: props.width, maxWidth: 'calc(100vw - 32px)', padding: 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDownCapture={(e) => {
            // Before CodeMirror's own bindings: Shift+Enter runs the cell as the grid does, Ctrl+S saves.
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              run();
            } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.stopPropagation();
              save();
            }
          }}
          onKeyDown={(e) => {
            // The grid's own keys must not see the editor's; Escape closes (and saves).
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          {props.editor !== undefined ? (
            <Suspense fallback={<span data-cells-code-loading="">Loading the editor…</span>}>
              {createElement(props.editor, editorProps)}
            </Suspense>
          ) : (
            <PlainEditor {...editorProps} />
          )}
        </div>
      </Overlay>
    </ThemeProvider>
  );
}

/** The editor with no renderer contributed: a textarea over the source, *Save* writes it back as one undo step. */
export function PlainEditor({
  model,
  sheet,
  row,
  col,
  onClose,
  register,
}: CodeEditorRendererProps) {
  const m = model as CellsModel;
  const code = m.code(sheet, row, col);
  const [text, setText] = useState(code?.source ?? '');
  const latest = useRef(text);
  latest.current = text;
  const write = () => {
    const current = m.code(sheet, row, col);
    if (current !== undefined && latest.current !== current.source)
      m.dispatch({
        type: 'SET_CODE',
        sheet,
        row,
        col,
        code: { ...current, source: latest.current },
      });
  };
  register?.({ save: write });
  if (code === undefined) return null;
  const save = () => {
    write();
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
