/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `<Spreadsheet>` (and its alias `<Cells>`): the canvas grid as a React
 * component. A native scroll container gives wheel, trackpad inertia, touch
 * and scrollbars; it sits over the canvases, which draw the grid inside its
 * scrollbars (the scrollbars' gutter is left to them, themed from the cells
 * theme), so the scrollbars show and take the pointer.
 * One focusable element is the grid for keyboards and screen readers; a
 * hidden mirror of the visible cells carries their names.
 *
 * @module react/Spreadsheet
 */

import {
  formatKeybinding,
  matchesKeybinding,
  parseKeybinding,
  type PlatformInput,
  type ReactorPlatform,
} from '@datalayer/reactor';
import type { CellsCommandArgument, CellsGridAccess } from '../builtins/editing.js';
import { clearCellsCommandTarget, setCellsCommandTarget } from '../builtins/target.js';
import { CellsMenuItems, type CommandItem } from '../points/index.js';
import type { Style } from '../core/styles.js';
import {
  type CSSProperties,
  Fragment,
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Command, CommandResult } from '../core/commands.js';
import type { DataSourceError } from '../core/dataSources.js';
import type { CellsWorkbook } from '../core/format.js';
import {
  type CellsModel,
  createCellsModel,
  type EditState,
  type Transaction,
} from '../core/model.js';
import { resolveCell, resolveRange } from '../core/refs.js';
import {
  initialSelection,
  navigate,
  type Navigation,
  navigationGrid,
  type SelectionState,
} from '../core/selection.js';
import { type CellValue, isCellError } from '../core/values.js';
import { columnLetters, type Zone, zoneContains, zoneToA1 } from '../core/zone.js';
import type { Slice } from '../core/clipboard.js';
import { sliceFromClipboard, sliceToClipboard } from './clipboard.js';
import { display } from '../render/numberFormat.js';
import { EN_US, type NumberLocale } from '../core/numfmt.js';
import { CanvasRenderer, type RendererCounters } from '../render/renderer.js';
import { ScrollMapper, spacerSize } from '../render/scroll.js';
import { type CellsTheme, checkTheme } from '../render/theme.js';
import { cellAt, cellRect, headerAt, paneAt, type Viewport } from '../render/viewport.js';
import { fontOf } from '../render/paint.js';
import { ChartsLayer } from './ChartsLayer.js';
import { CodeLayer, shownOutputs } from './CodeLayer.js';
import { codeFrame, codeRef } from '../core/code.js';
import { ActionList, Overlay, registerPortalRoot, ThemeProvider } from '@primer/react';
import {
  callAt,
  canPoint,
  isFormulaText,
  namePrefix,
  referenceText,
  referencesIn,
  toggleAnchors,
} from '../formula/editing.js';
import { CellsProvider } from './hooks.js';
import { announce, type Messages } from './messages.js';
import { autoTheme, type ColorMode, variantTheme } from './theme.js';

/** What the imperative handle offers (`ref` on `<Spreadsheet>`). */
export interface CellsHandle {
  readonly model: CellsModel;
  dispatch(command: Command): CommandResult;
  transact<T>(label: string, fn: () => T): T;
  undo(): boolean;
  redo(): boolean;
  /** Select `B3`, `A1:C4` or `Sheet2!A1:B2`. */
  select(ref: string): void;
  getSelection(): SelectionState;
  /** Scroll so a cell shows, at the nearest edge or the start. */
  scrollTo(ref: string, options?: { align?: 'nearest' | 'start' }): void;
  focus(): void;
  toJSON(): CellsWorkbook;
  /** Repaint everything on the next frame. */
  repaint(): void;
  /** The renderer's counters: frames, repaints, blits, the last frame's timings. */
  renderStats(): RendererCounters | undefined;
}

/** A cell of a grid: its sheet id, row and column. */
export interface CellRef {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
}

/** The props of `<Spreadsheet>` (§3.6): the model or data, plugins, appearance, behaviour and events. */
export interface SpreadsheetProps {
  /** Controlled: the host owns the model (create it once, outside render). Never with `defaultData`. */
  readonly model?: CellsModel;
  /** Uncontrolled: the component creates its model from this workbook, once. */
  readonly defaultData?: CellsWorkbook;
  /** Uncontrolled: Reactor plugins the component's model is built with. */
  readonly plugins?: readonly PlatformInput[];
  /** Uncontrolled: a started Reactor platform to run on (with CellsCorePlugin). */
  readonly reactor?: ReactorPlatform;
  /** Uncontrolled: refuse every command. */
  readonly readOnly?: boolean;
  /** The sheet shown, by id; with `onSheetChange`, controlled. */
  readonly sheet?: string;
  readonly onSheetChange?: (sheet: string) => void;
  readonly showGridlines?: boolean;
  readonly showHeaders?: boolean;
  /** 0.5 to 4. */
  readonly zoom?: number;
  /** Decimal and group separators, month and day names, for number formats; en-US by default. */
  readonly locale?: NumberLocale;
  /** `auto` (the host's Primer variables), a primer-addons variant (`loop`, `datalayer`, …), or a CellsTheme. */
  readonly theme?: 'auto' | string | CellsTheme;
  readonly colorMode?: ColorMode;
  /** The live region's sentences, by command type. */
  readonly messages?: Messages;
  /** Keybindings by Reactor command id (`cells.insertRowsAbove`: `Mod+Alt+=`); `null` unbinds. */
  readonly keymap?: Readonly<Record<string, string | null>>;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly 'aria-label'?: string;
  /** The `?debug=cells` overlay: frame time, repaints, cache and model counters. */
  readonly debug?: boolean;
  readonly onChange?: (transaction: Transaction) => void;
  readonly onSelectionChange?: (selection: SelectionState) => void;
  readonly onCommandRejected?: (result: CommandResult & { ok: false }) => void;
  /** A data source's page failed (C7-03): which source, which rows, and the error; its cells show `#N/A`. */
  readonly onDataSourceError?: (error: DataSourceError) => void;
  readonly onCellClick?: (cell: CellRef, event: React.PointerEvent) => void;
  readonly onContextMenu?: (cell: CellRef, event: React.MouseEvent) => void;
  readonly onViewportChange?: (view: {
    sheet: string;
    rows: [number, number];
    cols: [number, number];
  }) => void;
  readonly children?: ReactNode;
}

/** The mirror holds at most this many cells (§ accessibility). */
export const MIRROR_CAP = 1000;

/** How long the pointer rests on a code cell with outputs before its preview opens, ms. */
export const CODE_HOVER_MS = 300;

/**
 * Whether a pointer event is on the scroller's own scrollbars (past its client
 * box): the browser drags the thumb or pages on the track, the grid does not
 * select or open its menu there.
 */
function onScrollbar(
  e: { target: EventTarget | null; clientX: number; clientY: number },
  scroller: HTMLElement | null,
): boolean {
  if (scroller === null || e.target !== scroller) return false;
  const rect = scroller.getBoundingClientRect();
  return (
    e.clientX - rect.left >= scroller.clientLeft + scroller.clientWidth ||
    e.clientY - rect.top >= scroller.clientTop + scroller.clientHeight
  );
}

function errorMeaning(code: string): string {
  const meanings: Record<string, string> = {
    '#DIV/0!': 'division by zero',
    '#REF!': 'invalid reference',
    '#NAME?': 'unknown name',
    '#VALUE!': 'wrong type of value',
    '#N/A': 'not available',
    '#NUM!': 'invalid number',
    '#NULL!': 'empty intersection',
    '#CYCLE!': 'circular reference',
    '#BUSY!': 'still calculating',
    '#SPILL!': 'cannot spill',
    '#ERROR!': 'the code raised an error',
  };
  return meanings[code] ?? 'error';
}

/** The accessible name of a cell: what it shows, then its formula, then what an error means. */
export function accessibleName(model: CellsModel, sheet: string, row: number, col: number): string {
  const content = model.content(sheet, row, col);
  if (content !== null && content.value === null && content.formula === undefined) {
    // An empty typed cell that paints itself (a code cell not run yet) still has a name.
    const empty = model.cellType(sheet, row, col)?.value;
    if (empty?.paintsEmpty === true && empty.accessibleName !== undefined)
      return empty.accessibleName(null, model.style(sheet, row, col), { sheet, row, col, model });
  }
  if (content === null) {
    // A bound cell whose page is away says so (`#BUSY!`), or is empty.
    const bound = model.dataSource(sheet)?.zone;
    if (bound === undefined || !zoneContains(bound, { row, col })) return '';
    const away = model.value(sheet, row, col);
    if (away === null) return '';
    return isCellError(away) ? `${away.error}, ${errorMeaning(away.error)}` : display(away).text;
  }
  const value: CellValue = model.value(sheet, row, col);
  const style = model.style(sheet, row, col);
  const type = model.cellType(sheet, row, col)?.value;
  let name =
    type?.accessibleName !== undefined
      ? type.accessibleName(value, style, { sheet, row, col, model })
      : display(value, style.format).text;
  if (content.formula !== undefined) name += `, formula: =${content.formula}`;
  if (isCellError(value)) name += `, ${errorMeaning(value.error)}`;
  return name;
}

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** The grid (§3.6): a canvas spreadsheet with its editor, accessibility mirror and context menu, over a `CellsModel`. */
export const Spreadsheet = forwardRef<CellsHandle, SpreadsheetProps>(
  function Spreadsheet(props, ref) {
    // ------------------------------------------------------------ the model
    const mode = useRef<'controlled' | 'uncontrolled' | null>(null);
    if (props.model !== undefined && props.defaultData !== undefined) {
      throw new Error(
        '<Spreadsheet> takes model (controlled) or defaultData (uncontrolled), not both.',
      );
    }
    const now = props.model !== undefined ? 'controlled' : 'uncontrolled';
    if (mode.current === null) mode.current = now;
    else if (mode.current !== now) {
      throw new Error(
        `<Spreadsheet> switched from ${mode.current} to ${now} after mount; create a new component instead.`,
      );
    }
    if (
      now === 'controlled' &&
      (props.plugins !== undefined || props.reactor !== undefined || props.readOnly !== undefined)
    ) {
      throw new Error(
        'plugins, reactor and readOnly configure the model the component creates; with a model prop, give them to createCellsModel.',
      );
    }
    const [own] = useState<CellsModel | null>(() =>
      props.model === undefined
        ? createCellsModel({
            data: props.defaultData,
            plugins: props.reactor === undefined ? props.plugins : undefined,
            reactor: props.reactor,
            readOnly: props.readOnly,
          })
        : null,
    );
    const model = props.model ?? own!;

    // ------------------------------------------------------------ elements and renderer
    const uid = useId().replace(/:/g, '');
    // The context menu (a Primer Overlay) portals into the spreadsheet's own element, so it sits
    // under the host's theme and at the grid's coordinates, as the overlay canvas does; beside the
    // grid, not in it: a grid owns rows only (axe's aria-required-children).
    const portalName = `cells-${uid}`;
    useLayoutEffect(() => {
      const holder = rootRef.current?.parentElement;
      if (holder) registerPortalRoot(holder, portalName);
    }, [portalName]);
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<CanvasRenderer | null>(null);
    const mappers = useRef({ x: new ScrollMapper(), y: new ScrollMapper() });
    const [viewport, setViewport] = useState<Viewport | null>(null);
    const [theme, setTheme] = useState<CellsTheme | null>(null);
    const [spacer, setSpacer] = useState({ width: 0, height: 0 });
    /** What the canvases draw: the root less the scrollbars' gutter. */
    const [size, setSize] = useState({ width: 0, height: 0 });
    /** The scrollbars' thickness, CSS px: 0 with overlay scrollbars. */
    const [gutter, setGutter] = useState({ right: 0, bottom: 0 });
    const [announcement, setAnnouncement] = useState('');
    const [, setRevision] = useState(0);
    /** Grows on changes to the cells only (not the selection): what the mirror's rows re-read names on. */
    const [contentRevision, setContentRevision] = useState(0);
    const props_ = useRef(props);
    props_.current = props;

    const sheetId = props.sheet ?? model.selection.sheet;

    // Theme: resolved from the host, re-read when its colour mode, theme or the system's changes.
    const themeProp = props.theme ?? 'auto';
    const colorMode = props.colorMode ?? 'auto';
    useLayoutEffect(() => {
      const root = rootRef.current!;
      let cancelled = false;
      const resolve = () => {
        if (typeof themeProp === 'object') {
          checkTheme(themeProp);
          setTheme(themeProp);
        } else if (themeProp === 'auto') {
          setTheme(autoTheme(root, colorMode));
        } else {
          void variantTheme(themeProp, root, colorMode).then((t) => {
            if (!cancelled) setTheme(t);
          });
        }
      };
      resolve();
      const observer = new MutationObserver(resolve);
      for (let el: Element | null = root.parentElement; el; el = el.parentElement) {
        observer.observe(el, {
          attributes: true,
          attributeFilter: [
            'data-color-mode',
            'data-theme',
            'data-light-theme',
            'data-dark-theme',
            'style',
            'class',
          ],
        });
      }
      const queries =
        typeof matchMedia === 'function'
          ? [matchMedia('(prefers-color-scheme: dark)'), matchMedia('(forced-colors: active)')]
          : [];
      for (const q of queries) q.addEventListener('change', resolve);
      return () => {
        cancelled = true;
        observer.disconnect();
        for (const q of queries) q.removeEventListener('change', resolve);
      };
    }, [themeProp, colorMode]);

    // The renderer: one per mounted component; the model outlives it.
    useLayoutEffect(() => {
      if (theme === null) return;
      const renderer = new CanvasRenderer({
        model,
        grid: gridRef.current!,
        overlay: overlayRef.current!,
        theme,
        showGridlines: props_.current.showGridlines,
        showHeaders: props_.current.showHeaders,
      });
      rendererRef.current = renderer;
      renderer.setSheet(sheetId);
      renderer.setZoom(props_.current.zoom ?? 1);
      if (size.width > 0) renderer.setSize(size.width, size.height, devicePixelRatio || 1);
      setViewport(renderer.viewport);
      return () => {
        renderer.dispose();
        rendererRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [model, theme === null]);

    useEffect(() => {
      if (theme) rendererRef.current?.setTheme(theme);
    }, [theme]);

    const syncView = useCallback(() => {
      const r = rendererRef.current;
      if (r === null) return;
      const vp = r.viewport;
      setViewport(vp);
      const main = vp.panes.find((p) => p.name === 'main')!;
      const width = spacerSize(vp.maxScrollX * vp.zoom, main.width);
      const height = spacerSize(vp.maxScrollY * vp.zoom, main.height);
      setSpacer((s) => (s.width === width && s.height === height ? s : { width, height }));
      props_.current.onViewportChange?.({
        sheet: r.sheet,
        rows: [main.firstRow, main.lastRow],
        cols: [main.firstCol, main.lastCol],
      });
    }, []);

    useEffect(() => {
      const r = rendererRef.current;
      if (r === null) return;
      r.setOptions({ showGridlines: props.showGridlines, showHeaders: props.showHeaders });
      r.setZoom(props.zoom ?? 1);
      r.setLocale(props.locale ?? EN_US);
      r.setSheet(sheetId);
      syncView();
    }, [
      props.showGridlines,
      props.showHeaders,
      props.zoom,
      props.locale,
      sheetId,
      syncView,
      theme,
    ]);

    // Size and DPR.
    useLayoutEffect(() => {
      const root = rootRef.current!;
      const measure = () => {
        const rect = root.getBoundingClientRect();
        // The scroller always shows its scrollbars (overflow: scroll), so their gutter is fixed:
        // the canvases draw inside it and the viewport ends where the scrollbars start.
        const scroller = scrollerRef.current;
        const g = scroller
          ? {
              right: Math.max(0, scroller.offsetWidth - scroller.clientWidth),
              bottom: Math.max(0, scroller.offsetHeight - scroller.clientHeight),
            }
          : { right: 0, bottom: 0 };
        setGutter((s) => (s.right === g.right && s.bottom === g.bottom ? s : g));
        const next = {
          width: Math.max(0, Math.floor(rect.width) - g.right),
          height: Math.max(0, Math.floor(rect.height) - g.bottom),
        };
        setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
        rendererRef.current?.setSize(next.width, next.height, devicePixelRatio || 1);
        syncView();
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      let media: MediaQueryList | null = null;
      const watchDpr = () => {
        media?.removeEventListener('change', onDpr);
        media =
          typeof matchMedia === 'function'
            ? matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`)
            : null;
        media?.addEventListener('change', onDpr);
      };
      const onDpr = () => {
        measure();
        watchDpr();
      };
      watchDpr();
      return () => {
        observer.disconnect();
        media?.removeEventListener('change', onDpr);
      };
    }, [syncView]);

    const [edit, setEdit] = useState(model.edit);
    useEffect(() => model.subscribeEdit(setEdit), [model]);

    // Model events: the host's callbacks, the live region, the mirror's revision.
    useEffect(() => {
      const a = model.subscribe((tx) => {
        setRevision((n) => n + 1);
        setContentRevision((n) => n + 1);
        setAnnouncement(announce(tx, props_.current.messages));
        props_.current.onChange?.(tx);
        syncView();
      });
      const c = model.subscribeDataSourceErrors((error) => {
        props_.current.onDataSourceError?.(error);
      });
      const b = model.subscribeSelection((s) => {
        setRevision((n) => n + 1);
        props_.current.onSelectionChange?.(s);
        if (s.sheet !== rendererRef.current?.sheet && props_.current.sheet === undefined) {
          rendererRef.current?.setSheet(s.sheet);
          syncView();
        }
      });
      return () => {
        a();
        b();
        c();
      };
    }, [model, syncView]);

    // ------------------------------------------------------------ scrolling
    const onScroll = useCallback(() => {
      const r = rendererRef.current;
      const el = scrollerRef.current;
      if (r === null || el === null) return;
      const vp = r.viewport;
      const main = vp.panes.find((p) => p.name === 'main')!;
      const x = mappers.current.x.map(el.scrollLeft, {
        maxContent: vp.maxScrollX * vp.zoom,
        viewport: main.width,
      });
      const y = mappers.current.y.map(el.scrollTop, {
        maxContent: vp.maxScrollY * vp.zoom,
        viewport: main.height,
      });
      r.setScroll(x / vp.zoom, y / vp.zoom);
      syncView();
    }, [syncView]);

    /** Scroll so a cell shows in the main pane. */
    const scrollToCell = useCallback(
      (row: number, col: number, align: 'nearest' | 'start' = 'nearest') => {
        const r = rendererRef.current;
        const el = scrollerRef.current;
        if (r === null || el === null) return;
        const sheet = model.sheet(r.sheet);
        const vp = r.viewport;
        const main = vp.panes.find((p) => p.name === 'main')!;
        const { x: sx, y: sy } = r.scroll;
        const frozenW = sheet.cols.offsetOf(sheet.frozen.cols);
        const frozenH = sheet.rows.offsetOf(sheet.frozen.rows);
        const w = main.width / vp.zoom;
        const h = main.height / vp.zoom;
        let nx = sx;
        let ny = sy;
        if (col >= sheet.frozen.cols) {
          const left = sheet.cols.offsetOf(col) - frozenW;
          const right = sheet.cols.offsetOf(col + 1) - frozenW;
          if (align === 'start' || left < sx) nx = left;
          else if (right > sx + w) nx = right - w;
        }
        if (row >= sheet.frozen.rows) {
          const top = sheet.rows.offsetOf(row) - frozenH;
          const bottom = sheet.rows.offsetOf(row + 1) - frozenH;
          if (align === 'start' || top < sy) ny = top;
          else if (bottom > sy + h) ny = bottom - h;
        }
        if (nx === sx && ny === sy) return;
        nx = Math.min(Math.max(0, nx), vp.maxScrollX);
        ny = Math.min(Math.max(0, ny), vp.maxScrollY);
        r.setScroll(nx, ny);
        el.scrollLeft = mappers.current.x.domFor(nx * vp.zoom, {
          maxContent: vp.maxScrollX * vp.zoom,
          viewport: main.width,
        });
        el.scrollTop = mappers.current.y.domFor(ny * vp.zoom, {
          maxContent: vp.maxScrollY * vp.zoom,
          viewport: main.height,
        });
        syncView();
      },
      [model, syncView],
    );

    // ------------------------------------------------------------ keyboard and pointer
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    /** The code cell whose outputs are previewed at the cell (a hover, Alt+Down), and where the preview goes. */
    const [codePreview, setCodePreview] = useState<{
      row: number;
      col: number;
      x: number;
      y: number;
    } | null>(null);
    /** The preview as the pointer handlers see it (they are memoised: a ref, not a stale closure). */
    const previewRef = useRef(codePreview);
    previewRef.current = codePreview;
    /** The hover's timer, and the cell it waits on. */
    const hover = useRef<{ row: number; col: number; timer: ReturnType<typeof setTimeout> } | null>(
      null,
    );
    /** Whether the pointer is over the preview overlay (then leaving the cell keeps it). */
    const overPreview = useRef(false);
    const cancelHover = () => {
      if (hover.current !== null) clearTimeout(hover.current.timer);
      hover.current = null;
    };
    /** The code cell open in the editor overlay (*Open in editor*), and where the overlay goes. */
    const [codeEditing, setCodeEditing] = useState<{
      row: number;
      col: number;
      x: number;
      y: number;
    } | null>(null);
    /** Escape was pressed: the next Tab leaves the grid. */
    const leaving = useRef(false);
    const measure = useCallback(
      (text: string, style: Style) =>
        theme === null ? text.length * 8 : measureText(fontOf(style, theme, 1), text),
      [theme],
    );
    /** What this grid lends its commands: the sheet it shows, its page, its scrolling, its menu. */
    const gridAccess = useMemo<CellsGridAccess>(
      () => ({
        get sheet() {
          return rendererRef.current?.sheet ?? model.selection.sheet;
        },
        get pageRows() {
          const r = rendererRef.current;
          if (r === null) return 1;
          const main = r.viewport.panes.find((p) => p.name === 'main')!;
          return Math.max(1, main.lastRow - main.firstRow);
        },
        scrollTo: (row: number, col: number) => scrollToCell(row, col),
        openMenu: () => {
          const r = rendererRef.current;
          if (r === null) return;
          // With a chart selected, the menu opens on its frame (its items act on that chart).
          const chartId = model.selectedChart;
          const frame =
            chartId === null
              ? undefined
              : [
                  ...(rootRef.current?.parentElement?.querySelectorAll('[data-cells-chart]') ?? []),
                ].find((el) => el.getAttribute('data-cells-chart') === chartId);
          if (frame !== undefined) {
            const f = frame.getBoundingClientRect();
            const root = rootRef.current!.getBoundingClientRect();
            setMenu({ x: f.left - root.left + 16, y: f.top - root.top + 16 });
            return;
          }
          const sheetNow = model.sheet(r.sheet);
          const pane = r.viewport.panes.find((p) => p.name === 'main')!;
          const rect = cellRect(
            pane,
            r.viewport.zoom,
            sheetNow.rows,
            sheetNow.cols,
            model.selection.active.row,
            model.selection.active.col,
          );
          setMenu({ x: rect.x + rect.width / 2, y: rect.y + rect.height });
        },
        focusOutput: (row: number, col: number) => {
          const frame = rootRef.current?.parentElement?.querySelector<HTMLElement>(
            `[data-cells-code-output="${codeRef(row, col)}"]`,
          );
          if (frame === null || frame === undefined) return false;
          frame.focus({ preventScroll: false });
          return true;
        },
        openCodeEditor: (row: number, col: number) => {
          const r = rendererRef.current;
          if (r === null) return;
          const sheetNow = model.sheet(r.sheet);
          const pane = r.viewport.panes.find((p) => p.name === 'main')!;
          const rect = cellRect(pane, r.viewport.zoom, sheetNow.rows, sheetNow.cols, row, col);
          setCodePreview(null);
          setCodeEditing({ row, col, x: rect.x, y: rect.y + rect.height });
        },
        previewOutput: (row: number, col: number) => {
          const r = rendererRef.current;
          if (r === null) return false;
          const code = model.code(r.sheet, row, col);
          // One copy of the outputs: a pinned frame shows them, never a preview too.
          if (
            code === undefined ||
            shownOutputs(code).length === 0 ||
            codeFrame(code) !== undefined
          )
            return false;
          const sheetNow = model.sheet(r.sheet);
          const pane = r.viewport.panes.find((p) => p.name === 'main')!;
          const rect = cellRect(pane, r.viewport.zoom, sheetNow.rows, sheetNow.cols, row, col);
          setCodePreview({ row, col, x: rect.x, y: rect.y + rect.height });
          return true;
        },
      }),
      [model, scrollToCell],
    );
    /** The argument this grid runs its commands with; also the one a palette's run reaches. */
    const commandArgument = useMemo<CellsCommandArgument>(
      () => ({ model, measure, grid: gridAccess }),
      [model, measure, gridAccess],
    );
    // A command run with no argument (a palette, an agent) acts on the grid that last had the focus.
    useEffect(() => {
      setCellsCommandTarget(commandArgument);
      return () => clearCellsCommandTarget(commandArgument);
    }, [commandArgument]);
    /** Run a Reactor command on this grid's model; a refusal is said in the live region and to the host. */
    const runCommand = useCallback(
      (id: string) => {
        model.reactor.executeCommand(id, commandArgument).catch((error: Error) => {
          setAnnouncement(error.message);
          props_.current.onCommandRejected?.({
            ok: false,
            refusals: [{ reason: 'Command', message: error.message }],
          });
        });
      },
      [model, commandArgument],
    );

    /**
     * Activate a typed cell (§3.11): a click in its hit area or one of its keys. A command is
     * dispatched (a refusal is said), a URL opens in a new tab. `true` when the type took it.
     */
    const activateCell = useCallback(
      (cell: { sheet: string; row: number; col: number }): boolean => {
        const type = model.cellType(cell.sheet, cell.row, cell.col)?.value;
        if (type?.activate === undefined) return false;
        const value = model.value(cell.sheet, cell.row, cell.col);
        const context = {
          workbook: model.workbook,
          value: (s: string, r: number, c: number) => model.value(s, r, c),
          contributions: <T,>(point: Parameters<CellsModel['reactor']['getContributions']>[0]) =>
            model.reactor.getContributions(point).map((x) => x.value) as T[],
        };
        const action = type.activate(cell, value, context as never);
        if (action === undefined) return true;
        if ('open' in action) {
          if (typeof window !== 'undefined')
            window.open(action.open, '_blank', 'noopener,noreferrer');
          return true;
        }
        const result = model.dispatch(action.command as Command);
        if (!result.ok) {
          setAnnouncement(result.refusals[0]?.message ?? `${type.id} refused.`);
          props_.current.onCommandRejected?.(result);
        }
        return true;
      },
      [model],
    );

    /** With a chart selected: arrows move it by one cell, Shift+arrows resize it, Delete removes it, Escape returns to the cells. */
    const chartKey = useCallback(
      (e: React.KeyboardEvent): boolean => {
        if (model.selectedChart === null) return false;
        const arrows: Record<string, [string, string]> = {
          ArrowUp: ['moveUp', 'shrinkUp'],
          ArrowDown: ['moveDown', 'growDown'],
          ArrowLeft: ['moveLeft', 'shrinkLeft'],
          ArrowRight: ['moveRight', 'growRight'],
        };
        const arrow = arrows[e.key];
        let id: string | undefined;
        if (arrow !== undefined) id = `cells.chart.${e.shiftKey ? arrow[1] : arrow[0]}`;
        else if (e.key === 'Delete' || e.key === 'Backspace') id = 'cells.chart.delete';
        else if (e.key === 'Escape') {
          model.selectChart(null);
          rootRef.current?.focus({ preventScroll: true });
          e.preventDefault();
          return true;
        } else if (e.key === 'Enter' && e.shiftKey) id = 'cells.chart.showData';
        else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))
          id = 'cells.openContextMenu';
        if (id === undefined) return false;
        e.preventDefault();
        runCommand(id);
        return true;
      },
      [model, runCommand],
    );

    /** The cell under a point in the main or a frozen pane, with its rectangle in view px. */
    const cellBoxAt = useCallback(
      (e: { clientX: number; clientY: number }, cell: { row: number; col: number }) => {
        const r = rendererRef.current;
        const root = rootRef.current;
        if (r === null || root === null) return undefined;
        const rect = root.getBoundingClientRect();
        const pane = paneAt(r.viewport, e.clientX - rect.left, e.clientY - rect.top);
        if (pane === undefined) return undefined;
        const sheet = model.sheet(r.sheet);
        const box = cellRect(pane, r.viewport.zoom, sheet.rows, sheet.cols, cell.row, cell.col);
        return {
          ...box,
          px: e.clientX - rect.left - box.x,
          py: e.clientY - rect.top - box.y,
        };
      },
      [model],
    );

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.target !== rootRef.current) return;
        const r = rendererRef.current;
        if (r === null) return;
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v')
          pasteValues.current = true;
        if (chartKey(e)) return;
        if (e.key === 'Escape' && model.clipboardMark !== null) {
          model.clearClipboardMark();
          return;
        }
        // Tab moves between cells; Escape, then Tab, leaves the grid (no keyboard trap, WCAG 2.1.2).
        if (e.key === 'Escape') {
          leaving.current = true;
          setAnnouncement('Press Tab to leave the grid.');
          return;
        }
        if (e.key === 'Tab' && leaving.current) {
          leaving.current = false;
          return; // the browser moves the focus on
        }
        leaving.current = false;
        // A typed cell's own keys (Space on a checkbox, Enter on a link) come before any command.
        if (!e.ctrlKey && !e.metaKey && !e.altKey && model.selection.sheet === r.sheet) {
          const active = model.selection.active;
          const type = model.cellType(r.sheet, active.row, active.col)?.value;
          if (type?.activateOn?.includes(e.key) && type.activate !== undefined) {
            e.preventDefault();
            activateCell({ sheet: r.sheet, row: active.row, col: active.col });
            return;
          }
        }
        // Every other key is a command's (editing, navigation, any plugin's in the Cells category), after the host's keymap.
        const command = commandFor(model, e.nativeEvent, props_.current.keymap);
        if (command !== undefined) {
          e.preventDefault();
          runCommand(command);
          return;
        }
        // Typing over a cell replaces it; an IME's first key opens the editor empty.
        const mod = e.ctrlKey || e.metaKey;
        if (!model.readOnly && !mod && !e.altKey && (e.key.length === 1 || e.key === 'Process')) {
          e.preventDefault();
          const active = model.selection.active;
          if (model.cellType(r.sheet, active.row, active.col)?.value.editable === false) return;
          scrollToCell(model.selection.active.row, model.selection.active.col);
          model.startEdit(undefined, e.key === 'Process' ? '' : e.key);
        }
      },
      [model, scrollToCell, runCommand, activateCell],
    );

    /** Ctrl+Shift+V asks the next paste for values only. */
    const pasteValues = useRef(false);
    const onCopy = useCallback(
      (e: React.ClipboardEvent, cut: boolean) => {
        // The editor's own copy and paste stay native; anything else inside the grid is the grid's.
        if (
          (e.target as Element).closest?.(
            '[data-cells-editor], [data-cells-menu], [data-cells-chart], [data-cells-chart-holder]',
          )
        )
          return;
        e.preventDefault();
        const slice = model.copy(undefined, { cut });
        const { text, html } = sliceToClipboard(slice, model);
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', html);
        const z = slice.source!.zone;
        setAnnouncement(`${cut ? 'Cut' : 'Copied'} ${zoneToA1(z)}`);
      },
      [model],
    );
    const onPaste = useCallback(
      (e: React.ClipboardEvent) => {
        // The editor's own copy and paste stay native; anything else inside the grid is the grid's.
        if (
          (e.target as Element).closest?.(
            '[data-cells-editor], [data-cells-menu], [data-cells-chart], [data-cells-chart-holder]',
          )
        )
          return;
        e.preventDefault();
        const special = pasteValues.current ? 'values' : 'all';
        pasteValues.current = false;
        if (model.readOnly) return;
        let slice: Slice | undefined;
        try {
          slice = sliceFromClipboard(
            e.clipboardData.getData('text/html') || undefined,
            e.clipboardData.getData('text/plain') || undefined,
          );
        } catch (error) {
          setAnnouncement(`Nothing pasted: ${(error as Error).message}`);
          return;
        }
        if (slice === undefined) return;
        const result = model.paste(slice, undefined, { special });
        if (!result.ok) {
          setAnnouncement(result.refusals.map((r) => r.message).join(' '));
          props_.current.onCommandRejected?.(result);
          return;
        }
        // The pasted zone becomes the selection, as in Excel.
        const at = model.selection.active;
        const zone = {
          top: at.row,
          left: at.col,
          bottom: at.row + slice.rows - 1,
          right: at.col + slice.cols - 1,
        };
        model.select({ ...model.selection, zones: [zone], anchor: at, active: at });
        setAnnouncement(`Pasted ${zoneToA1(zone)}`);
      },
      [model],
    );

    const dragging = useRef(false);
    /** A header drag: selecting whole rows or columns, or resizing one. */
    const headerDrag = useRef<
      | { kind: 'select'; axis: 'rows' | 'cols'; from: number }
      | { kind: 'resize'; axis: 'rows' | 'cols'; index: number; start: number; size: number }
      | null
    >(null);
    const [guide, setGuide] = useState<{ axis: 'rows' | 'cols'; at: number } | null>(null);
    /** A fill-handle drag: the source, and the zone it would fill. */
    const fillDrag = useRef<{ source: Zone; target: Zone } | null>(null);
    const [fillPreview, setFillPreview] = useState<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>(null);

    /** Where the fill handle is, canvas px, for the last zone; `undefined` when it is not on screen. */
    const fillHandleAt = useCallback(() => {
      const r = rendererRef.current;
      if (r === null) return undefined;
      const s = model.selection;
      if (s.sheet !== r.sheet) return undefined;
      const z = s.zones[s.zones.length - 1];
      const sheet = model.sheet(r.sheet);
      const pane = r.viewport.panes.find(
        (p) =>
          z.bottom >= p.firstRow &&
          z.bottom <= p.lastRow &&
          z.right >= p.firstCol &&
          z.right <= p.lastCol,
      );
      if (pane === undefined) return undefined;
      const br = cellRect(pane, r.viewport.zoom, sheet.rows, sheet.cols, z.bottom, z.right);
      return { x: br.x + br.width, y: br.y + br.height, zone: z };
    }, [model]);

    /** The zone a fill drag covers: the source extended towards the pointer, along its larger distance. */
    const fillTarget = useCallback((source: Zone, cell: { row: number; col: number }): Zone => {
      const down = cell.row - source.bottom;
      const up = source.top - cell.row;
      const right = cell.col - source.right;
      const left = source.left - cell.col;
      const best = Math.max(down, up, right, left);
      if (best <= 0) return source;
      if (best === down) return { ...source, bottom: cell.row };
      if (best === up) return { ...source, top: cell.row };
      if (best === right) return { ...source, right: cell.col };
      return { ...source, left: cell.col };
    }, []);

    /** Point mode: the reference being pointed at while a formula is edited, and where it sits in the text. */
    const point = useRef<PointState | null>(null);
    const pointing = useRef(false);

    const zoneBox = useCallback(
      (zone: Zone) => {
        const r = rendererRef.current!;
        const sheet = model.sheet(r.sheet);
        const pane = r.viewport.panes.find((p) => p.name === 'main')!;
        const tl = cellRect(pane, r.viewport.zoom, sheet.rows, sheet.cols, zone.top, zone.left);
        const br = cellRect(pane, r.viewport.zoom, sheet.rows, sheet.cols, zone.bottom, zone.right);
        return { x: tl.x, y: tl.y, width: br.x + br.width - tl.x, height: br.y + br.height - tl.y };
      },
      [model],
    );

    const headerAtPoint = useCallback(
      (e: { clientX: number; clientY: number }) => {
        const r = rendererRef.current;
        const root = rootRef.current;
        if (r === null || root === null) return undefined;
        const rect = root.getBoundingClientRect();
        const sheet = model.sheet(r.sheet);
        return headerAt(
          r.viewport,
          sheet.rows,
          sheet.cols,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      },
      [model],
    );

    /** Select whole rows or columns, from an anchor index to another. */
    const selectLines = useCallback(
      (axis: 'rows' | 'cols', from: number, to: number) => {
        const r = rendererRef.current;
        if (r === null) return;
        const sheet = model.sheet(r.sheet);
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        const zone =
          axis === 'cols'
            ? { top: 0, bottom: sheet.rows.count - 1, left: lo, right: hi }
            : { left: 0, right: sheet.cols.count - 1, top: lo, bottom: hi };
        const anchor = axis === 'cols' ? { row: 0, col: from } : { row: from, col: 0 };
        model.select({ sheet: r.sheet, zones: [zone], anchor, active: anchor });
      },
      [model],
    );
    const pointToCell = useCallback(
      (e: { clientX: number; clientY: number }) => {
        const r = rendererRef.current;
        const root = rootRef.current;
        if (r === null || root === null) return undefined;
        const rect = root.getBoundingClientRect();
        const sheet = model.sheet(r.sheet);
        return cellAt(
          r.viewport,
          sheet.rows,
          sheet.cols,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      },
      [model],
    );

    const onPointerDown = useCallback(
      (e: React.PointerEvent) => {
        if (onScrollbar(e, scrollerRef.current)) return; // The browser drags the thumb.
        if (
          (e.target as Element).closest(
            '[data-cells-editor], [data-cells-popup], [data-cells-chart], [data-cells-chart-holder]',
          )
        )
          return;
        const editing = model.edit;
        if (editing !== null && e.button === 0 && isFormulaText(editing.text)) {
          // Pointing at a cell while a formula is edited puts its reference in the formula.
          const editor = rootRef.current?.querySelector<HTMLTextAreaElement>('[data-cells-editor]');
          const cell = pointToCell(e);
          const caret = editor?.selectionStart ?? editing.text.length;
          const p = point.current;
          if (
            cell !== undefined &&
            editor &&
            ((p !== null && p.end === caret) || canPoint(editing.text, caret))
          ) {
            e.preventDefault();
            const anchor = e.shiftKey && p !== null ? p.anchor : cell;
            pointAt(model, point, editing, anchor, cell, caret);
            pointing.current = true;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            editor.focus({ preventScroll: true });
            return;
          }
        }
        if (model.edit !== null) {
          const result = model.commitEdit();
          if (!result.ok) {
            props_.current.onCommandRejected?.(result);
            return;
          }
        }
        rootRef.current?.focus({ preventScroll: true });
        // The fill handle: a 24 × 24 px target around its square (WCAG 2.5.8).
        const handle = e.button === 0 && !model.readOnly ? fillHandleAt() : undefined;
        if (handle !== undefined) {
          const rect = rootRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          if (Math.abs(x - handle.x) <= 12 && Math.abs(y - handle.y) <= 12) {
            fillDrag.current = { source: handle.zone, target: handle.zone };
            setFillPreview(zoneBox(handle.zone));
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return;
          }
        }
        const header = e.button === 0 ? headerAtPoint(e) : undefined;
        if (header !== undefined && rendererRef.current !== null) {
          const sheet = model.sheet(rendererRef.current.sheet);
          const axisOf = header.axis === 'rows' ? sheet.rows : sheet.cols;
          if (header.edge !== undefined && !model.readOnly) {
            headerDrag.current = {
              kind: 'resize',
              axis: header.axis,
              index: header.edge,
              start: header.axis === 'rows' ? e.clientY : e.clientX,
              size: axisOf.sizeOf(header.edge),
            };
            setGuide({ axis: header.axis, at: header.axis === 'rows' ? header.y : header.x });
          } else {
            const s = model.selection;
            const from = e.shiftKey
              ? header.axis === 'cols'
                ? s.anchor.col
                : s.anchor.row
              : header.index;
            selectLines(header.axis, from, header.index);
            headerDrag.current = { kind: 'select', axis: header.axis, from };
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }
        const cell = pointToCell(e);
        const r = rendererRef.current;
        if (cell === undefined || r === null) return;
        if (e.button !== 0) return;
        const s = model.selection.sheet === r.sheet ? model.selection : initialSelection(r.sheet);
        const zone: Zone = { top: cell.row, left: cell.col, bottom: cell.row, right: cell.col };
        if (e.shiftKey)
          model.select({
            ...s,
            zones: [
              ...s.zones.slice(0, -1),
              {
                top: Math.min(s.anchor.row, cell.row),
                left: Math.min(s.anchor.col, cell.col),
                bottom: Math.max(s.anchor.row, cell.row),
                right: Math.max(s.anchor.col, cell.col),
              },
            ],
          });
        else if (e.ctrlKey || e.metaKey)
          model.select({ ...s, zones: [...s.zones, zone], anchor: cell, active: cell });
        else model.select(initialSelection(r.sheet, cell));
        dragging.current = true;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        props_.current.onCellClick?.({ sheet: r.sheet, ...cell }, e);
        // A click in a typed cell's hit area activates it (a checkbox toggles, a link opens).
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && e.isPrimary !== false) {
          const type = model.cellType(r.sheet, cell.row, cell.col)?.value;
          if (type?.activate !== undefined) {
            const box = cellBoxAt(e, cell);
            if (
              box !== undefined &&
              (type.hitTest === undefined ||
                type.hitTest({ x: box.px, y: box.py }, { width: box.width, height: box.height }))
            )
              activateCell({ sheet: r.sheet, ...cell });
          }
        }
      },
      [model, pointToCell, cellBoxAt, activateCell],
    );

    /** A hover over a code cell with outputs (300 ms) opens its preview; moving to another cell closes it. */
    const hoverAt = (e: React.PointerEvent) => {
      const r = rendererRef.current;
      const cell = r === null ? undefined : pointToCell(e);
      const over = hover.current;
      if (cell !== undefined && over !== null && over.row === cell.row && over.col === cell.col)
        return;
      cancelHover();
      const shown = previewRef.current;
      if (
        shown !== null &&
        (cell === undefined || shown.row !== cell.row || shown.col !== cell.col)
      ) {
        if (!overPreview.current) setCodePreview(null);
      }
      if (cell === undefined || r === null) return;
      const code = model.code(r.sheet, cell.row, cell.col);
      if (code === undefined || shownOutputs(code).length === 0 || codeFrame(code) !== undefined)
        return;
      if (shown !== null && shown.row === cell.row && shown.col === cell.col) return;
      hover.current = {
        row: cell.row,
        col: cell.col,
        timer: setTimeout(() => {
          hover.current = null;
          gridAccess.previewOutput?.(cell.row, cell.col);
        }, CODE_HOVER_MS),
      };
    };
    const onPointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (
          !onScrollbar(e, scrollerRef.current) &&
          !pointing.current &&
          fillDrag.current === null &&
          headerDrag.current === null &&
          !dragging.current
        )
          hoverAt(e);
        if (pointing.current) {
          const editing = model.edit;
          const p = point.current;
          const cell = pointToCell(e);
          if (editing !== null && p !== null && cell !== undefined)
            pointAt(model, point, editing, p.anchor, cell, p.start);
          return;
        }
        const fill = fillDrag.current;
        if (fill !== null) {
          const cell = pointToCell(e);
          if (cell !== undefined) {
            fill.target = fillTarget(fill.source, cell);
            setFillPreview(zoneBox(fill.target));
          }
          return;
        }
        const drag = headerDrag.current;
        if (drag !== null) {
          const header = headerAtPoint(e);
          if (drag.kind === 'select') {
            if (header !== undefined && header.axis === drag.axis)
              selectLines(drag.axis, drag.from, header.index);
          } else {
            const root = rootRef.current!.getBoundingClientRect();
            setGuide({
              axis: drag.axis,
              at: drag.axis === 'rows' ? e.clientY - root.top : e.clientX - root.left,
            });
          }
          return;
        }
        const hover = headerAtPoint(e);
        const handle = fillHandleAt();
        const rect = rootRef.current!.getBoundingClientRect();
        const onHandle =
          handle !== undefined &&
          Math.abs(e.clientX - rect.left - handle.x) <= 12 &&
          Math.abs(e.clientY - rect.top - handle.y) <= 12;
        rootRef.current!.style.cursor = onHandle
          ? 'crosshair'
          : hover?.edge !== undefined
            ? hover.axis === 'cols'
              ? 'col-resize'
              : 'row-resize'
            : '';
        if (!dragging.current) return;
        const cell = pointToCell(e);
        if (cell === undefined) return;
        const s = model.selection;
        const zone = {
          top: Math.min(s.anchor.row, cell.row),
          left: Math.min(s.anchor.col, cell.col),
          bottom: Math.max(s.anchor.row, cell.row),
          right: Math.max(s.anchor.col, cell.col),
        };
        const last = s.zones[s.zones.length - 1];
        if (
          last.top === zone.top &&
          last.left === zone.left &&
          last.bottom === zone.bottom &&
          last.right === zone.right
        )
          return;
        model.select({ ...s, zones: [...s.zones.slice(0, -1), zone] });
      },
      [model, pointToCell],
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent) => {
        if (pointing.current) {
          pointing.current = false;
          return;
        }
        dragging.current = false;
        const fill = fillDrag.current;
        if (fill !== null) {
          fillDrag.current = null;
          setFillPreview(null);
          const same = JSON.stringify(fill.source) === JSON.stringify(fill.target);
          if (!same) {
            const result = model.dispatch({
              type: 'FILL',
              sheet: model.selection.sheet,
              source: fill.source,
              target: fill.target,
              mode: e.ctrlKey || e.metaKey ? 'copy' : 'series',
            });
            if (result.ok) {
              model.select({ ...model.selection, zones: [fill.target] });
              setAnnouncement(`Filled ${zoneToA1(fill.target)}`);
            } else {
              setAnnouncement(result.refusals.map((x) => x.message).join(' '));
              props_.current.onCommandRejected?.(result);
            }
          }
          return;
        }
        const drag = headerDrag.current;
        headerDrag.current = null;
        if (drag === null || drag.kind !== 'resize') return;
        setGuide(null);
        const r = rendererRef.current;
        if (r === null) return;
        const z = r.viewport.zoom;
        const delta = ((drag.axis === 'rows' ? e.clientY : e.clientX) - drag.start) / z;
        const size = Math.max(4, Math.round(drag.size + delta));
        if (size === drag.size) return;
        // Every selected whole line takes the size, as Excel does, when the dragged one is among them.
        const s = model.selection;
        const sheet = model.sheet(r.sheet);
        const zone = s.zones[s.zones.length - 1];
        const whole =
          drag.axis === 'cols'
            ? zone.top === 0 &&
              zone.bottom === sheet.rows.count - 1 &&
              drag.index >= zone.left &&
              drag.index <= zone.right
            : zone.left === 0 &&
              zone.right === sheet.cols.count - 1 &&
              drag.index >= zone.top &&
              drag.index <= zone.bottom;
        const [from, to] = whole
          ? drag.axis === 'cols'
            ? [zone.left, zone.right]
            : [zone.top, zone.bottom]
          : [drag.index, drag.index];
        const result = model.dispatch({
          type: 'RESIZE_AXIS',
          sheet: r.sheet,
          axis: drag.axis,
          from,
          to,
          size,
        });
        if (!result.ok) props_.current.onCommandRejected?.(result);
      },
      [model],
    );

    /**
     * Double-click a cell: edit it, its content in the editor and the caret at
     * the end, as F2 does. A column's edge: fit it to its text; a row's edge:
     * back to the default height.
     */
    const onDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        const r = rendererRef.current;
        if (r === null || model.readOnly || e.button !== 0) return;
        if (onScrollbar(e, scrollerRef.current)) return;
        if (
          (e.target as Element).closest(
            '[data-cells-editor], [data-cells-chart], [data-cells-chart-holder]',
          )
        )
          return;
        const header = headerAtPoint(e);
        if (header === undefined) {
          const cell = pointToCell(e);
          if (cell === undefined) return;
          e.preventDefault();
          if (
            model.selection.sheet !== r.sheet ||
            model.selection.active.row !== cell.row ||
            model.selection.active.col !== cell.col
          )
            model.select(initialSelection(r.sheet, cell));
          // A code cell opens its editor overlay (jupyter-react's Cell), never the grid's text editor.
          if (model.code(r.sheet, cell.row, cell.col) !== undefined) {
            gridAccess.openCodeEditor?.(cell.row, cell.col);
            return;
          }
          model.startEdit(cell);
          return;
        }
        if (header.edge === undefined) return;
        if (header.axis === 'cols') {
          const s = model.selection;
          const zone = s.zones[s.zones.length - 1];
          if (!(header.edge >= zone.left && header.edge <= zone.right))
            selectLines('cols', header.edge, header.edge);
          runCommand('cells.fitColumns');
        } else {
          const sheet = model.sheet(r.sheet);
          model.dispatch({
            type: 'RESIZE_AXIS',
            sheet: r.sheet,
            axis: 'rows',
            from: header.edge,
            to: header.edge,
            size: sheet.rows.defaultSize,
          });
        }
      },
      [model, headerAtPoint, pointToCell, selectLines, runCommand, chartKey, gridAccess],
    );

    const onContextMenu = useCallback(
      (e: React.MouseEvent) => {
        if (onScrollbar(e, scrollerRef.current)) return;
        const cell = pointToCell(e);
        const r = rendererRef.current;
        if (cell === undefined || r === null) return;
        props_.current.onContextMenu?.({ sheet: r.sheet, ...cell }, e);
        if (e.defaultPrevented) return; // The host replaces the built-in menu.
        e.preventDefault();
        const s = model.selection;
        // A right-click on a chart keeps it selected: the menu's chart items act on it.
        const onChart = (e.target as Element).closest?.('[data-cells-chart-holder]') != null;
        if (!onChart && (s.sheet !== r.sheet || !s.zones.some((z) => zoneContains(z, cell))))
          model.select(initialSelection(r.sheet, cell));
        const rect = rootRef.current!.getBoundingClientRect();
        setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      },
      [model, pointToCell],
    );

    // ------------------------------------------------------------ handle
    useImperativeHandle(
      ref,
      (): CellsHandle => ({
        model,
        dispatch: (c) => {
          const result = model.dispatch(c);
          if (!result.ok) props_.current.onCommandRejected?.(result);
          return result;
        },
        transact: (label, fn) => model.transact(label, fn),
        undo: () => model.undo(),
        redo: () => model.redo(),
        select: (refText) => {
          const { sheet, zone } = resolveRange(model, refText);
          const at = { row: zone.top, col: zone.left };
          model.select({ sheet, zones: [zone], anchor: at, active: at });
        },
        getSelection: () => model.selection,
        scrollTo: (refText, options) => {
          const { row, col } = resolveCell(model, refText);
          scrollToCell(row, col, options?.align);
        },
        focus: () => rootRef.current?.focus(),
        toJSON: () => model.toJSON(),
        repaint: () => rendererRef.current?.repaint(),
        renderStats: () => (rendererRef.current ? { ...rendererRef.current.counters } : undefined),
      }),
      [model, scrollToCell],
    );

    // ------------------------------------------------------------ the accessibility mirror
    const sheet = model.workbook.hasSheet(sheetId) ? model.sheet(sheetId) : model.sheets[0];
    const selection = model.selection;
    const cellId = (row: number, col: number) => `${uid}-r${row}-c${col}`;
    const mirror = useMemo(() => {
      if (viewport === null) return { rows: [] as number[], cols: [] as number[] };
      const rowSet = new Set<number>();
      const colSet = new Set<number>();
      for (const p of viewport.panes) {
        for (let r = p.firstRow; r <= p.lastRow; r += 1)
          if (sheet.rows.effectiveSizeOf(r) > 0) rowSet.add(r);
        for (let c = p.firstCol; c <= p.lastCol; c += 1)
          if (sheet.cols.effectiveSizeOf(c) > 0) colSet.add(c);
      }
      if (selection.sheet === sheet.id) {
        rowSet.add(selection.active.row);
        colSet.add(selection.active.col);
      }
      let rows = [...rowSet].sort((a, b) => a - b);
      let cols = [...colSet].sort((a, b) => a - b);
      // Capped: the rows nearest the active cell first, every visible column while it fits.
      if (rows.length * cols.length > MIRROR_CAP) {
        const maxCols = Math.min(
          cols.length,
          Math.floor(MIRROR_CAP / Math.max(1, Math.min(rows.length, 20))),
        );
        cols = nearest(cols, selection.active.col, maxCols);
        rows = nearest(rows, selection.active.row, Math.floor(MIRROR_CAP / cols.length));
      }
      return { rows, cols };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewport, sheet, selection.active.row, selection.active.col, selection.sheet]);
    // The same columns keep the same array, so unchanged rows skip rendering.
    const colsKey = mirror.cols.join(',');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const mirrorCols = useMemo(() => mirror.cols, [colsKey]);

    /** The selected columns of a mirror row, as a string: a row re-renders only when it changes. */
    const selectedIn = (row: number): string => {
      if (selection.sheet !== sheet.id) return '';
      const out: number[] = [];
      for (const c of mirrorCols)
        if (selection.zones.some((z) => zoneContains(z, { row, col: c }))) out.push(c);
      return out.join(',');
    };
    const activeId =
      selection.sheet === sheet.id ? cellId(selection.active.row, selection.active.col) : undefined;
    const main = viewport?.panes.find((p) => p.name === 'main');

    return (
      <CellsProvider model={model}>
        <div
          className={props.className}
          style={{ position: 'relative', width: '100%', height: '100%', ...props.style }}
          data-cells=""
        >
          <div
            ref={rootRef}
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              outline: 'none',
              // The strips beside the scrollbars (past the headers) in the headers' colour.
              background: theme?.headerBackground,
            }}
            role="grid"
            tabIndex={0}
            aria-label={props['aria-label'] ?? `Spreadsheet, ${sheet.name}`}
            aria-rowcount={sheet.rows.count + 1}
            aria-colcount={sheet.cols.count + 1}
            aria-multiselectable="true"
            aria-description="Arrow keys move between cells, Tab and Enter too. Press Escape, then Tab, to leave the grid."
            aria-readonly={model.readOnly || undefined}
            aria-activedescendant={activeId}
            data-cells-sheet={sheet.id}
            onKeyDown={onKeyDown}
            onFocus={() => setCellsCommandTarget(commandArgument)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              cancelHover();
              if (!overPreview.current) setCodePreview(null);
            }}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onCopy={(e) => onCopy(e, false)}
            onCut={(e) => onCopy(e, true)}
            onPaste={onPaste}
          >
            <canvas
              ref={gridRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: size.width,
                height: size.height,
                pointerEvents: 'none',
              }}
            />
            <canvas
              ref={overlayRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: size.width,
                height: size.height,
                pointerEvents: 'none',
              }}
            />
            {/* The scroller, after the canvases so its scrollbars paint over them. */}
            <div
              ref={scrollerRef}
              onScroll={onScroll}
              data-cells-scroller=""
              style={{
                position: 'absolute',
                left: viewport ? viewport.panes.find((p) => p.name === 'main')!.x : 0,
                top: viewport ? viewport.panes.find((p) => p.name === 'main')!.y : 0,
                right: 0,
                bottom: 0,
                // Always both scrollbars: a fixed gutter the canvases leave free, and a thumb
                // that maps to the whole sheet (render/scroll). Over the canvases, which take no
                // pointer: the scroller takes the wheel, the thumb and the track.
                overflow: 'scroll',
                ...(theme !== null && !theme.forcedColors
                  ? ({
                      scrollbarColor: `${theme.textMuted} ${theme.headerBackground}`,
                      '--cells-scrollbar-thumb': theme.textMuted,
                      '--cells-scrollbar-track': theme.headerBackground,
                    } as CSSProperties)
                  : {}),
              }}
            >
              <div style={{ width: spacer.width, height: spacer.height }} />
            </div>
            <div style={visuallyHidden} data-cells-mirror="">
              <div role="row" aria-rowindex={1}>
                {mirror.cols.map((c) => (
                  <div key={c} role="columnheader" aria-colindex={c + 2}>
                    {columnLetters(c)}
                  </div>
                ))}
              </div>
              {mirror.rows.map((r) => (
                <MirrorRow
                  key={r}
                  model={model}
                  sheet={sheet.id}
                  row={r}
                  cols={mirrorCols}
                  uid={uid}
                  selected={selectedIn(r)}
                  revision={contentRevision}
                />
              ))}
            </div>
            {edit !== null && viewport !== null && edit.sheet === sheet.id && theme !== null && (
              <CellEditor
                model={model}
                edit={edit}
                viewport={viewport}
                theme={theme}
                onDone={(move) => {
                  rootRef.current?.focus({ preventScroll: true });
                  if (move) {
                    const s = model.selection;
                    const next = navigate(s, move, navigationGrid(model.sheet(s.sheet)));
                    model.select(next);
                    scrollToCell(next.active.row, next.active.col);
                  }
                }}
                onRejected={(r) => props_.current.onCommandRejected?.(r)}
                point={point}
              />
            )}
            {guide !== null && (
              <div
                aria-hidden="true"
                style={
                  guide.axis === 'cols'
                    ? {
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: guide.at,
                        width: 0,
                        borderLeft: `1px dashed ${theme?.selectionBorder ?? 'Highlight'}`,
                        zIndex: 3,
                        pointerEvents: 'none',
                      }
                    : {
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: guide.at,
                        height: 0,
                        borderTop: `1px dashed ${theme?.selectionBorder ?? 'Highlight'}`,
                        zIndex: 3,
                        pointerEvents: 'none',
                      }
                }
              />
            )}
            {edit !== null &&
              viewport !== null &&
              theme !== null &&
              edit.sheet === sheet.id &&
              referencesIn(edit.text)
                .filter(
                  (r) =>
                    r.sheet === undefined || r.sheet.toLowerCase() === sheet.name.toLowerCase(),
                )
                .map((r, i) => {
                  // The references of the formula being edited, outlined in the colours the editor gives them.
                  const box = zoneBox({
                    top: r.top ?? 0,
                    left: r.left ?? 0,
                    bottom: Math.min(r.bottom ?? sheet.rows.count - 1, sheet.rows.count - 1),
                    right: Math.min(r.right ?? sheet.cols.count - 1, sheet.cols.count - 1),
                  });
                  const color = theme.referenceColors[i % theme.referenceColors.length];
                  return (
                    <div
                      key={`${r.start}-${r.end}`}
                      data-cells-reference={edit.text.slice(r.start, r.end)}
                      style={{
                        position: 'absolute',
                        left: box.x,
                        top: box.y,
                        width: box.width,
                        height: box.height,
                        boxSizing: 'border-box',
                        border: `2px dashed ${color}`,
                        background: `${color}14`,
                        pointerEvents: 'none',
                        zIndex: 1,
                      }}
                    />
                  );
                })}
            {fillPreview !== null && (
              <div
                aria-hidden="true"
                data-cells-fill-preview=""
                style={{
                  position: 'absolute',
                  left: fillPreview.x,
                  top: fillPreview.y,
                  width: fillPreview.width,
                  height: fillPreview.height,
                  border: `1px dashed ${theme?.selectionBorder ?? 'Highlight'}`,
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                  zIndex: 3,
                }}
              />
            )}
            {menu !== null && (
              <ContextMenu
                model={model}
                x={menu.x}
                y={menu.y}
                keymap={props.keymap}
                portalName={portalName}
                returnFocusRef={rootRef}
                onRun={(id) => {
                  setMenu(null);
                  rootRef.current?.focus({ preventScroll: true });
                  runCommand(id);
                }}
                onClose={() => {
                  setMenu(null);
                  rootRef.current?.focus({ preventScroll: true });
                }}
              />
            )}
            {props.debug && rendererRef.current && main && (
              <DebugOverlay renderer={rendererRef.current} model={model} />
            )}
            {props.children}
          </div>
          {/* Charts and code outputs sit beside the grid, not in it: a grid owns rows only
              (axe's aria-required-children), and a figure or a region is not a row. The layer
              covers the grid, lets the pointer through, and hands a right-click to the grid's menu. */}
          <div
            data-cells-layers=""
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              right: gutter.right,
              bottom: gutter.bottom,
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
            onContextMenu={onContextMenu}
          >
            {viewport !== null && theme !== null && (
              <ChartsLayer
                model={model}
                sheet={sheet.id}
                viewport={viewport}
                theme={theme}
                selectedChart={model.selectedChart}
                onPointerDownChart={(id) => model.selectChart(id)}
                onChartKeyDown={chartKey}
              />
            )}
            {viewport !== null && theme !== null && (
              <CodeLayer
                model={model}
                sheet={sheet.id}
                viewport={viewport}
                theme={theme}
                editing={codeEditing}
                preview={codePreview}
                onClosePreview={() => {
                  overPreview.current = false;
                  setCodePreview(null);
                }}
                onPreviewPointer={(over) => {
                  overPreview.current = over;
                  if (!over) setCodePreview(null);
                }}
                portalName={portalName}
                returnFocusRef={rootRef}
                onCloseEditor={() => {
                  setCodeEditing(null);
                  rootRef.current?.focus({ preventScroll: true });
                }}
                onEscape={() => rootRef.current?.focus({ preventScroll: true })}
              />
            )}
          </div>
          <div style={visuallyHidden} aria-live="polite" data-cells-live="">
            {announcement}
          </div>
        </div>
      </CellsProvider>
    );
  },
);

/** The reference pointed at while a formula is edited: its cells, and its place in the text. */
interface PointState {
  readonly start: number;
  readonly end: number;
  readonly anchor: { row: number; col: number };
  readonly active: { row: number; col: number };
}

/**
 * Point at cells: their reference replaces the one pointed at before (when
 * the caret is still at its end), or goes in at the caret.
 */
function pointAt(
  model: CellsModel,
  point: { current: PointState | null },
  edit: EditState,
  anchor: { row: number; col: number },
  active: { row: number; col: number },
  caret: number,
): void {
  const p = point.current;
  const again = p !== null && (p.end === caret || p.start === caret);
  const start = again ? p.start : caret;
  const end = again ? p.end : caret;
  const ref = referenceText(anchor, active);
  model.setEditText(edit.text.slice(0, start) + ref + edit.text.slice(end));
  point.current = { start, end: start + ref.length, anchor, active };
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

function popupStyle(theme: CellsTheme): React.CSSProperties {
  return {
    position: 'absolute',
    maxWidth: 420,
    padding: '4px 0',
    font: `${theme.headerFontSize}px ${theme.fontFamily}`,
    background: theme.background,
    color: theme.text,
    border: `1px solid ${theme.gridline}`,
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
    zIndex: 3,
    paddingInline: 8,
  };
}

/**
 * The in-cell editor: a textarea over the cell, in the cell's font, growing
 * with its text. Enter and Tab commit and move (Shift goes back), Escape
 * cancels, Alt+Enter is a new line. Keys pressed while an input method
 * composes belong to the composition. A refused commit keeps the editor open
 * and says why (aria-describedby).
 */
function CellEditor(props: {
  model: CellsModel;
  edit: EditState;
  viewport: Viewport;
  theme: CellsTheme;
  onDone: (move: Navigation | undefined) => void;
  onRejected: (result: CommandResult & { ok: false }) => void;
  point: { current: PointState | null };
}) {
  const { model, edit, viewport: vp, theme, point } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [error, setError] = useState('');
  const errorId = useId();
  const sheet = model.sheet(edit.sheet);
  const pane =
    vp.panes.find(
      (p) =>
        edit.row >= p.firstRow &&
        edit.row <= p.lastRow &&
        edit.col >= p.firstCol &&
        edit.col <= p.lastCol,
    ) ?? vp.panes.find((p) => p.name === 'main')!;
  const merge = sheet.mergeAt(edit.row, edit.col);
  const tl = cellRect(pane, vp.zoom, sheet.rows, sheet.cols, edit.row, edit.col);
  const bottomRight = merge
    ? cellRect(pane, vp.zoom, sheet.rows, sheet.cols, merge.bottom, merge.right)
    : tl;
  const cellWidth = bottomRight.x + bottomRight.width - tl.x;
  const cellHeight = bottomRight.y + bottomRight.height - tl.y;
  const style = model.style(edit.sheet, edit.row, edit.col);
  const font = fontOf(style, theme, vp.zoom);
  const width = useMemo(() => {
    const longest = edit.text
      .split('\n')
      .reduce((w, line) => Math.max(w, measureText(font, line)), 0);
    return Math.min(
      Math.max(cellWidth, longest + 16 * vp.zoom),
      Math.max(cellWidth, pane.x + pane.width - tl.x),
    );
  }, [edit.text, font, cellWidth, vp.zoom, pane.x, pane.width, tl.x]);
  const lines = edit.text.split('\n').length;
  const lineHeight = (style.size ?? theme.fontSize) * vp.zoom * 1.25;
  const height = Math.max(cellHeight, lines * lineHeight + 6 * vp.zoom);

  useLayoutEffect(() => {
    const el = ref.current!;
    // Take the focus only from this grid: an edit started from a formula bar keeps it there.
    if (!el.closest('[data-cells]')?.contains(document.activeElement)) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.row, edit.col, edit.sheet]);

  /** Where the caret goes once a text the editor changed itself is rendered. */
  const caret = useRef<number | null>(null);
  const [at, setAt] = useState(edit.text.length);
  useLayoutEffect(() => {
    const to = caret.current ?? point.current?.end ?? null;
    if (to === null) return;
    ref.current?.setSelectionRange(to, to);
    caret.current = null;
    setAt(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.text]);
  // A new edit starts with nothing pointed at.
  useLayoutEffect(() => {
    point.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.row, edit.col, edit.sheet]);

  // Autocomplete: the functions whose names start with what is typed at the caret.
  const typed = isFormulaText(edit.text) ? namePrefix(edit.text, at) : undefined;
  const suggestions = useMemo(
    () =>
      typed === undefined
        ? []
        : model
            .functionNames()
            .filter((n) => n.startsWith(typed.prefix.toUpperCase()))
            .slice(0, 8),
    [model, typed?.prefix, typed?.start],
  );
  const [chosen, setChosen] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listOpen = suggestions.length > 0 && dismissed !== `${typed?.start}:${typed?.prefix}`;
  useEffect(() => setChosen(0), [typed?.prefix]);
  const accept = (name: string) => {
    const t = typed!;
    const text = `${edit.text.slice(0, t.start)}${name}(${edit.text.slice(at)}`;
    caret.current = t.start + name.length + 1;
    point.current = null;
    model.setEditText(text);
  };
  // Argument hint: the function the caret is in, its argument in bold.
  const call = isFormulaText(edit.text) ? callAt(edit.text, at) : undefined;
  const fn = call ? model.formulaFunction(call.name) : undefined;
  const listId = useId();
  const hintId = useId();

  const commit = (move: Navigation | undefined) => {
    const result = model.commitEdit();
    if (result.ok) {
      setError('');
      props.onDone(move);
    } else {
      setError(result.refusals.map((r) => r.message).join(' '));
      props.onRejected(result);
    }
  };

  const label = `Edit ${columnLetters(edit.col)}${edit.row + 1}, ${sheet.name}`;
  return (
    <>
      <textarea
        ref={ref}
        data-cells-editor=""
        aria-label={label}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        value={edit.text}
        spellCheck={false}
        role={isFormulaText(edit.text) ? 'combobox' : undefined}
        aria-expanded={isFormulaText(edit.text) ? listOpen : undefined}
        aria-controls={listOpen ? listId : undefined}
        aria-autocomplete={isFormulaText(edit.text) ? 'list' : undefined}
        aria-activedescendant={listOpen ? `${listId}-${chosen}` : undefined}
        onChange={(e) => {
          point.current = null;
          setAt(e.target.selectionStart);
          model.setEditText(e.target.value);
        }}
        onSelect={(e) => setAt(e.currentTarget.selectionStart)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={(e) => {
          // Focus moving to the grid itself is the editor closing; elsewhere, commit as Excel does.
          if (model.edit === null || e.relatedTarget?.getAttribute('role') === 'grid') return;
          commit(undefined);
        }}
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing) return;
          const el = e.currentTarget;
          if (listOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = suggestions.length;
              setChosen((chosen + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) {
              e.preventDefault();
              accept(suggestions[chosen]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(`${typed?.start}:${typed?.prefix}`);
              return;
            }
          }
          if (e.key === 'F4' && isFormulaText(edit.text)) {
            e.preventDefault();
            const toggled = toggleAnchors(edit.text, el.selectionStart);
            if (toggled !== undefined) {
              caret.current = toggled.caret;
              point.current = null;
              model.setEditText(toggled.text);
            }
            return;
          }
          const step = ARROWS[e.key];
          if (
            step !== undefined &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            isFormulaText(edit.text)
          ) {
            const p = point.current;
            const caretAt = el.selectionStart;
            if (
              el.selectionEnd === caretAt &&
              ((p !== null && p.end === caretAt) || canPoint(edit.text, caretAt))
            ) {
              // Point mode: the arrows move a reference over the grid, Shift stretches it.
              e.preventDefault();
              const from = p?.active ?? { row: edit.row, col: edit.col };
              const s = model.sheet(edit.sheet);
              const active = {
                row: Math.max(0, Math.min(s.rows.count - 1, from.row + step[0])),
                col: Math.max(0, Math.min(s.cols.count - 1, from.col + step[1])),
              };
              const anchor = e.shiftKey && p !== null ? p.anchor : active;
              pointAt(model, point, edit, anchor, active, caretAt);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            model.cancelEdit();
            setError('');
            props.onDone(undefined);
          } else if (e.key === 'Enter' && e.altKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const at = el.selectionStart;
            caret.current = at + 1;
            model.setEditText(`${edit.text.slice(0, at)}\n${edit.text.slice(el.selectionEnd)}`);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            commit({ type: 'cycle', by: 'col', reverse: e.shiftKey });
          } else if (e.key === 'Tab') {
            e.preventDefault();
            commit({ type: 'cycle', by: 'row', reverse: e.shiftKey });
          }
        }}
        style={{
          position: 'absolute',
          left: tl.x,
          top: tl.y,
          width,
          height,
          boxSizing: 'border-box',
          margin: 0,
          padding: `${2 * vp.zoom}px ${3 * vp.zoom}px`,
          border: `2px solid ${theme.activeCellBorder}`,
          outline: 'none',
          resize: 'none',
          overflow: 'hidden',
          whiteSpace: 'pre',
          font,
          lineHeight: `${lineHeight}px`,
          color: style.color ?? theme.text,
          background: style.fill ?? theme.background,
          zIndex: 2,
        }}
      />
      {listOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label="Functions"
          data-cells-popup=""
          style={{ ...popupStyle(theme), left: tl.x, top: tl.y + height + 2 }}
        >
          {suggestions.map((name, i) => (
            <div
              key={name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === chosen}
              onPointerDown={(e) => {
                e.preventDefault();
                accept(name);
              }}
              style={{
                padding: '2px 8px',
                cursor: 'pointer',
                background: i === chosen ? theme.headerSelectedBackground : undefined,
              }}
            >
              <strong>{name}</strong>{' '}
              <span style={{ opacity: 0.75 }}>{model.formulaFunction(name)?.description}</span>
            </div>
          ))}
        </div>
      )}
      {!listOpen && fn !== undefined && call !== undefined && (
        <div
          id={hintId}
          role="tooltip"
          data-cells-popup=""
          style={{ ...popupStyle(theme), left: tl.x, top: tl.y + height + 2 }}
        >
          {fn.name}(
          {fn.args.map((a, i) => {
            const current =
              i === call.argument ||
              (a.repeating === true && i < call.argument && i === fn.args.length - 1);
            const name = a.optional ? `[${a.name}${a.repeating ? ', …' : ''}]` : a.name;
            return (
              <span key={a.name}>
                {i > 0 && ', '}
                {current ? <strong>{name}</strong> : name}
              </span>
            );
          })}
          )<div style={{ opacity: 0.75 }}>{fn.description}</div>
        </div>
      )}
      {error && (
        <div
          id={errorId}
          role="alert"
          style={{
            position: 'absolute',
            left: tl.x,
            top: tl.y + height + 2,
            maxWidth: 320,
            padding: '4px 8px',
            font: `${theme.headerFontSize}px ${theme.fontFamily}`,
            background: theme.background,
            color: theme.errorText,
            border: `1px solid ${theme.errorText}`,
            zIndex: 3,
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}

/** The keybindings of a command (its Reactor one, then its grid ones), after the host's keymap. */
function bindingsOf(
  command: { id: string; keybinding?: string; gridKeybindings?: readonly string[] },
  keymap?: Readonly<Record<string, string | null>>,
): readonly string[] {
  if (keymap !== undefined && command.id in keymap) {
    const bound = keymap[command.id];
    return bound === null || bound === undefined ? [] : [bound];
  }
  return [
    ...(command.keybinding !== undefined ? [command.keybinding] : []),
    ...(command.gridKeybindings ?? []),
  ];
}

/** The keybinding a command shows (its first), after the host's keymap. */
function bindingOf(
  command: { id: string; keybinding?: string; gridKeybindings?: readonly string[] },
  keymap?: Readonly<Record<string, string | null>>,
): string | undefined {
  return bindingsOf(command, keymap)[0];
}

/** The Cells command a key press means, if any. */
function commandFor(
  model: CellsModel,
  event: KeyboardEvent,
  keymap?: Readonly<Record<string, string | null>>,
): string | undefined {
  for (const c of model.reactor.listCommands()) {
    if (c.category !== 'Cells') continue;
    // A command unavailable here (Run on a cell that is not code) leaves the key to the next.
    if (c.isEnabled !== undefined && !c.isEnabled()) continue;
    for (const binding of bindingsOf(c, keymap)) {
      const parsed = parseKeybinding(binding);
      if (parsed !== null && matchesKeybinding(event, parsed)) return c.id;
    }
  }
  return undefined;
}

/**
 * The built-in context menu: the commands contributed to
 * `datalayer.cells.menuItem`, in order, grouped, with their keybindings.
 * Arrow keys move, Enter runs, Escape closes.
 */
/**
 * The context menu: Primer's `Overlay` (into the grid's portal root, at the
 * cell's coordinates) holding an `ActionList` with `role="menu"`, one item
 * per `datalayer.cells.menuItem` contribution whose command exists, its
 * keybinding as the trailing visual, a divider between groups. The keyboard:
 * arrows, Home and End move (Primer's own), Enter or Space runs (the item's
 * `onSelect`), Escape closes and returns focus to the grid; the pointer:
 * hover focuses (Primer's hover state), a click runs.
 */
function ContextMenu(props: {
  model: CellsModel;
  x: number;
  y: number;
  keymap?: Readonly<Record<string, string | null>>;
  portalName: string;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const { model } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const commands = new Map(model.reactor.listCommands().map((c) => [c.id, c]));
    return model.reactor
      .getContributions(CellsMenuItems)
      .map((c) => ({ item: c.value, command: commands.get(c.value.command) }))
      .filter(
        (x): x is { item: CommandItem; command: NonNullable<typeof x.command> } =>
          x.command !== undefined,
      );
  }, [model]);
  // A Primer ThemeProvider with no props takes the host's theme when it has one, Primer's
  // default otherwise: the Overlay needs one either way.
  return (
    <ThemeProvider>
      <Overlay
        role="menu"
        aria-label="Cell actions"
        returnFocusRef={props.returnFocusRef as React.RefObject<HTMLElement>}
        onClickOutside={props.onClose}
        onEscape={props.onClose}
        portalContainerName={props.portalName}
        position="absolute"
        top={props.y}
        left={props.x}
        width="auto"
        // Primer draws the Overlay from its CSS variables, which a host only
        // has when its theme defines them (a plain ThemeProvider does not):
        // without them the menu had no background (28 October 2026). The
        // system's canvas colours stand in, and follow light and dark.
        style={{
          backgroundColor: 'var(--overlay-bgColor, Canvas)',
          color: 'var(--fgColor-default, CanvasText)',
          boxShadow:
            'var(--shadow-floating-small, 0 0 0 1px rgba(128, 128, 128, 0.35), 0 8px 24px rgba(0, 0, 0, 0.2))',
        }}
        data-cells-menu=""
      >
        <div
          ref={listRef}
          data-cells-menu=""
          style={{ minWidth: 220, maxHeight: 360, overflowY: 'auto' }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // The grid's own keys must not see the menu's. Primer's ActionList moves the focus on
            // arrows, Home and End; Escape is handled here, since the event stops before Primer's
            // document listener.
            e.stopPropagation();
            // No blur-close: Primer's open-focus effect returns focus to the grid on its cleanup
            // (StrictMode re-runs it), which a blur handler would take for leaving the menu.
            if (e.key === 'Escape' || e.key === 'Tab') {
              e.preventDefault();
              props.onClose();
            }
          }}
        >
          <ActionList role="menu">
            {items.map(({ item, command }, i) => {
              const binding = bindingOf(command, props.keymap);
              const separator = i > 0 && items[i - 1].item.group !== item.group;
              return (
                <Fragment key={command.id}>
                  {separator && <ActionList.Divider />}
                  <ActionList.Item
                    role="menuitem"
                    aria-keyshortcuts={binding}
                    onSelect={() => props.onRun(command.id)}
                    onMouseEnter={(e: React.MouseEvent<HTMLElement>) => {
                      const target = (e.currentTarget.closest('[role="menuitem"]') ??
                        e.currentTarget.querySelector('[role="menuitem"]') ??
                        e.currentTarget) as HTMLElement;
                      target.focus();
                    }}
                  >
                    {command.name}
                    {binding && (
                      <ActionList.TrailingVisual>
                        {/* The leading space keeps the visible text "Undo Ctrl+Z", as the item's
                            name reads (axe's label-content-name-mismatch). */}
                        {` ${formatKeybinding(binding)}`}
                      </ActionList.TrailingVisual>
                    )}
                  </ActionList.Item>
                </Fragment>
              );
            })}
          </ActionList>
        </div>
      </Overlay>
    </ThemeProvider>
  );
}

let measuring: CanvasRenderingContext2D | null = null;
/** Text width in a font, from a canvas kept for measuring. */
function measureText(font: string, text: string): number {
  measuring ??= document.createElement('canvas').getContext('2d');
  if (measuring === null) return text.length * 8;
  measuring.font = font;
  return measuring.measureText(text).width;
}

/** One row of the accessibility mirror; re-renders when its cells, columns or selection change. */
const MirrorRow = memo(function MirrorRow(props: {
  model: CellsModel;
  sheet: string;
  row: number;
  cols: readonly number[];
  uid: string;
  /** The selected columns, comma-separated. */
  selected: string;
  revision: number;
}) {
  const { model, sheet, row, cols, uid } = props;
  const selected = new Set(props.selected === '' ? [] : props.selected.split(',').map(Number));
  return (
    <div role="row" aria-rowindex={row + 2}>
      <div role="rowheader" aria-colindex={1}>
        {row + 1}
      </div>
      {cols.map((c) => (
        <div
          key={c}
          id={`${uid}-r${row}-c${c}`}
          role="gridcell"
          aria-colindex={c + 2}
          aria-selected={selected.has(c)}
        >
          {accessibleName(model, sheet, row, c)}
        </div>
      ))}
    </div>
  );
});

function nearest(sorted: number[], around: number, n: number): number[] {
  if (sorted.length <= n) return sorted;
  let i = sorted.findIndex((x) => x >= around);
  if (i < 0) i = sorted.length - 1;
  const start = Math.max(0, Math.min(i - Math.floor(n / 2), sorted.length - n));
  return sorted.slice(start, start + n);
}

/** The debug overlay (`debug`, or `?debug=cells` in the examples): counters, refreshed twice a second. */
function DebugOverlay({ renderer, model }: { renderer: CanvasRenderer; model: CellsModel }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const c = renderer.counters;
  const s = model.stats();
  const lru = renderer.measure.cache;
  const hit =
    lru.hits + lru.misses === 0 ? 0 : Math.round((100 * lru.hits) / (lru.hits + lru.misses));
  return (
    <pre
      data-cells-debug=""
      style={{
        position: 'absolute',
        right: 8,
        bottom: 8,
        margin: 0,
        padding: 8,
        font: '11px monospace',
        background: 'rgba(0,0,0,0.75)',
        color: '#fff',
        borderRadius: 4,
        pointerEvents: 'none',
      }}
    >
      {`frame ${c.lastFrameMs.toFixed(2)} ms · frames ${c.frames}
grid full ${c.gridFull} · partial ${c.gridPartial} · blits ${c.blits} · overlay ${c.overlay}
painted ${c.cells} cells, ${c.texts} texts
text cache ${lru.size} · hit ${hit} %
cells ${s.cells.toLocaleString()} · chunks ${s.chunks} · strings ${s.strings} · styles ${s.styles}`}
    </pre>
  );
}

/** The same component, under the package's own name. */
export const Cells = Spreadsheet;
