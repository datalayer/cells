/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * One chart of a model, usable outside the grid (a dashboard): the frame of
 * the grid's chart layer, sized by its props rather than by the anchor. The
 * model comes from the `CellsProvider` around it, or from the `model` prop.
 *
 * @module charts/CellsChart
 */

import { type CSSProperties, useCallback, useMemo, useSyncExternalStore } from 'react';
import { chartRendererOf, resolveChart } from '../core/chartOption.js';
import type { CellsModel } from '../core/model.js';
import { LIGHT_THEME, type CellsTheme } from '../render/theme.js';
import { ChartFrame } from '../react/ChartFrame.js';
import { CellsProvider, useCells, useChart } from '../react/hooks.js';

export interface CellsChartProps {
  readonly id: string;
  /** The sheet the chart is on; the active sheet by default. */
  readonly sheet?: string;
  /** The model, when no `CellsProvider` is around. */
  readonly model?: CellsModel;
  readonly theme?: CellsTheme;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function Chart(props: CellsChartProps) {
  const model = useCells();
  const { spec, revision } = useChart(props.id, props.sheet);
  const sheet = props.sheet ?? model.selection.sheet;
  const theme = props.theme ?? LIGHT_THEME;
  const subscribePlatform = useCallback(
    (notify: () => void) => model.reactor.subscribe(notify),
    [model],
  );
  const platform = useSyncExternalStore(
    subscribePlatform,
    () => model.reactor.getRevision(),
    () => model.reactor.getRevision(),
  );
  const renderer = chartRendererOf(model.reactor);
  const resolved = useMemo(
    () =>
      spec === undefined
        ? undefined
        : resolveChart(
            model,
            sheet,
            props.id,
            theme,
            renderer === undefined ? 'not-loaded' : 'loaded',
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, sheet, props.id, spec, revision, theme, platform, renderer === undefined],
  );
  if (spec === undefined || resolved === undefined) return null;
  return (
    <ChartFrame
      spec={spec}
      resolved={resolved}
      renderer={renderer}
      width={props.width ?? 480}
      height={props.height ?? 300}
      theme={theme}
      className={props.className}
      style={props.style}
    />
  );
}

export function CellsChart(props: CellsChartProps) {
  if (props.model !== undefined)
    return (
      <CellsProvider model={props.model}>
        <Chart {...props} />
      </CellsProvider>
    );
  return <Chart {...props} />;
}
