/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The frame of one chart (§3.12): `role="figure"`, named by the chart's
 * title or its generated name, described by its data in words; inside it,
 * the renderer `CellsChartsPlugin` contributes draws the option, or a
 * labelled placeholder says why the chart is not drawn ("A column chart:
 * charts are not loaded"). The grid's chart layer and `<CellsChart>` of
 * `./charts` both draw through it.
 *
 * @module react/ChartFrame
 */

import {
  createElement,
  type CSSProperties,
  type ComponentType,
  useEffect,
  useId,
  useRef,
} from 'react';
import type { ResolvedChart } from '../core/chartOption.js';
import type { ChartSpec } from '../core/charts.js';
import type { ChartRenderer, ChartRendererProps, Resolved } from '../points/index.js';
import type { CellsTheme } from '../render/theme.js';

/** The props of `<ChartFrame>`. */
export interface ChartFrameProps {
  readonly spec: ChartSpec;
  readonly resolved: ResolvedChart;
  readonly renderer: Resolved<ChartRenderer> | undefined;
  readonly width: number;
  readonly height: number;
  readonly theme: CellsTheme;
  /** `false` keeps the frame and its name, and draws nothing in it (a chart off screen). */
  readonly mounted?: boolean;
  readonly selected?: boolean;
  /** Focus the frame when it becomes selected (*Go to chart*, a click), so its name and description are read. */
  readonly focusWhenSelected?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** The most rows of the hidden data table; the rest is named by a sentence and the source range. */
export const CHART_TABLE_CAP = 1000;

/** The hidden table of a chart's data: categories × series, capped at {@link CHART_TABLE_CAP} rows. */
export function ChartDataTable({ resolved, label }: { resolved: ResolvedChart; label: string }) {
  if (resolved.kind !== 'option') return null;
  const { data } = resolved;
  const n = Math.max(0, ...data.series.map((s) => s.values.length));
  const rows = Math.min(n, CHART_TABLE_CAP);
  const sources = data.series.map((s) => s.source).filter((s): s is string => s !== undefined);
  return (
    <div style={VISUALLY_HIDDEN} data-cells-chart-table="">
      <table>
        <caption>{`Data of ${label}`}</caption>
        <thead>
          <tr>
            <th scope="col">{data.categories.length > 0 ? 'Category' : '#'}</th>
            {data.series.map((s, i) => (
              <th key={i} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <th scope="row">{String(data.categories[i] ?? i + 1)}</th>
              {data.series.map((s, j) => (
                <td key={j}>
                  {s.values[i] === null || s.values[i] === undefined ? '' : String(s.values[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {n > rows && (
        <p>{`${n - rows} more rows are not listed; the data is in ${sources.join(', ') || 'the sheet'}.`}</p>
      )}
    </div>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** The accessible name of a chart: its title, or the first sentence of its description. */
export function chartLabel(spec: ChartSpec, resolved: ResolvedChart): string {
  if (spec.title !== undefined && spec.title !== '') return spec.title;
  if (resolved.kind === 'option') return resolved.description.split('. ')[0];
  return resolved.text;
}

/** A chart's frame in the grid: `role="figure"`, its name, description and hidden data table, selectable and movable. */
export function ChartFrame(props: ChartFrameProps) {
  const { spec, resolved, renderer, width, height, theme } = props;
  const label = chartLabel(spec, resolved);
  const description = resolved.kind === 'option' ? resolved.description : resolved.text;
  const mounted = props.mounted !== false && resolved.kind === 'option' && renderer !== undefined;
  const descriptionId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.selected && props.focusWhenSelected) ref.current?.focus({ preventScroll: true });
  }, [props.selected, props.focusWhenSelected]);
  return (
    <div
      ref={ref}
      role="figure"
      tabIndex={-1}
      aria-label={label}
      aria-describedby={descriptionId}
      aria-selected={props.selected || undefined}
      data-cells-chart={spec.id}
      data-cells-chart-type={spec.type}
      className={props.className}
      style={{
        boxSizing: 'border-box',
        width,
        height,
        overflow: 'hidden',
        background: theme.chartBackground,
        border: `1px solid ${props.selected ? theme.selectionBorder : theme.gridline}`,
        color: theme.chartText,
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
        ...props.style,
      }}
    >
      {mounted ? (
        createElement(renderer!.value.component as ComponentType<ChartRendererProps>, {
          option: resolved.option,
          modules: resolved.type.value.modules,
          width: width - 2,
          height: height - 2,
          theme,
        })
      ) : resolved.kind === 'placeholder' ? (
        <div
          data-cells-chart-placeholder=""
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            textAlign: 'center',
            padding: 8,
            boxSizing: 'border-box',
            color: theme.textMuted,
          }}
        >
          {resolved.text}
        </div>
      ) : null}
      <div id={descriptionId} style={VISUALLY_HIDDEN}>
        {description}
      </div>
      <ChartDataTable resolved={resolved} label={label} />
    </div>
  );
}
