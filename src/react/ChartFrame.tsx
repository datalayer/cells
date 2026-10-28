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

import { createElement, type CSSProperties, type ComponentType } from 'react';
import type { ResolvedChart } from '../core/chartOption.js';
import type { ChartSpec } from '../core/charts.js';
import type { ChartRenderer, ChartRendererProps, Resolved } from '../points/index.js';
import type { CellsTheme } from '../render/theme.js';

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
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** The accessible name of a chart: its title, or the first sentence of its description. */
export function chartLabel(spec: ChartSpec, resolved: ResolvedChart): string {
  if (spec.title !== undefined && spec.title !== '') return spec.title;
  if (resolved.kind === 'option') return resolved.description.split('. ')[0];
  return resolved.text;
}

export function ChartFrame(props: ChartFrameProps) {
  const { spec, resolved, renderer, width, height, theme } = props;
  const label = chartLabel(spec, resolved);
  const description = resolved.kind === 'option' ? resolved.description : resolved.text;
  const mounted = props.mounted !== false && resolved.kind === 'option' && renderer !== undefined;
  return (
    <div
      role="figure"
      aria-label={label}
      aria-description={description}
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
    </div>
  );
}
