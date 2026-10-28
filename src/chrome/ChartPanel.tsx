/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The chart panel (§3.12, C10-04): Primer form controls editing the selected
 * chart's type and variant, title, series ranges, legend, axes and labels.
 * Every edit is an `UPDATE_CHART`, so it undoes as one step; a refusal is
 * told through `onError` and the field keeps what was typed.
 *
 * @module chrome/ChartPanel
 */

import { Button, Checkbox, FormControl, Select, TextInput } from '@primer/react';
import { useEffect, useState } from 'react';
import {
  BUILTIN_CHART_TYPES,
  CHART_VARIANTS,
  type ChartSeries,
  type ChartSpec,
} from '../core/charts.js';
import { chartTypeTable } from '../core/chartOption.js';
import { useCells, useCharts } from '../react/hooks.js';

export interface ChartPanelProps {
  /** Told a refusal's sentence. */
  readonly onError?: (message: string) => void;
  readonly 'aria-label'?: string;
}

const LEGENDS = ['top', 'right', 'bottom', 'left', 'none'] as const;

/** The chart types a picker lists: the contributed ones when a charts plugin is loaded, else the seven built-ins. */
export function chartTypeChoices(
  model: ReturnType<typeof useCells>,
): { id: string; label: string }[] {
  const contributed = chartTypeTable(model.reactor).all();
  if (contributed.length > 0)
    return contributed.map((t) => ({ id: t.value.id, label: t.value.label }));
  return BUILTIN_CHART_TYPES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
}

/** A text field committed on blur or Enter; refused values stay in the field. */
function Field(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <FormControl>
      <FormControl.Label>{props.label}</FormControl.Label>
      <TextInput
        size="small"
        block
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== props.value && props.onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (text !== props.value) props.onCommit(text);
          }
        }}
      />
    </FormControl>
  );
}

export function ChartPanel(props: ChartPanelProps) {
  const model = useCells();
  const { selected, charts, update } = useCharts();
  const spec = selected === null ? undefined : charts.find((c) => c.id === selected);
  if (spec === undefined)
    return (
      <div data-cells-chart-panel="" aria-label={props['aria-label'] ?? 'Chart'} role="region">
        <p>Select a chart to edit it.</p>
      </div>
    );
  const change = (changes: Partial<Omit<ChartSpec, 'id' | 'anchor'>>) => {
    const r = update(spec.id, changes);
    if (!r.ok) props.onError?.(r.refusals.map((x) => x.message).join(' '));
  };
  const series = (i: number, patch: Partial<ChartSeries>) =>
    change({
      data: {
        ...spec.data,
        series: spec.data.series.map((s, j) => (j === i ? ({ ...s, ...patch } as ChartSeries) : s)),
      },
    });
  const axis = (name: 'x' | 'y' | 'y2', patch: Record<string, unknown>) => {
    const current = { ...(spec.axes?.[name] ?? {}), ...patch } as Record<string, unknown>;
    for (const k of Object.keys(current))
      if (current[k] === undefined || current[k] === '') delete current[k];
    change({ axes: { ...(spec.axes ?? {}), [name]: current } });
  };
  const number = (text: string) => (text.trim() === '' ? undefined : Number(text));
  return (
    <div
      data-cells-chart-panel=""
      role="region"
      aria-label={props['aria-label'] ?? `Chart ${spec.title ?? spec.id}`}
      style={{ display: 'grid', gap: 8, padding: 8, maxWidth: 360 }}
    >
      <FormControl>
        <FormControl.Label>Type</FormControl.Label>
        <Select
          size="small"
          block
          value={spec.type}
          onChange={(e) => change({ type: e.target.value })}
        >
          {chartTypeChoices(model).map((t) => (
            <Select.Option key={t.id} value={t.id}>
              {t.label}
            </Select.Option>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <FormControl.Label>Variant</FormControl.Label>
        <Select
          size="small"
          block
          value={spec.variant ?? ''}
          onChange={(e) =>
            change({ variant: (e.target.value || undefined) as ChartSpec['variant'] })
          }
        >
          <Select.Option value="">None</Select.Option>
          {CHART_VARIANTS.map((v) => (
            <Select.Option key={v} value={v}>
              {v}
            </Select.Option>
          ))}
        </Select>
      </FormControl>
      <Field
        label="Title"
        value={spec.title ?? ''}
        onCommit={(t) => change({ title: t === '' ? undefined : t })}
      />
      {spec.data.series.map((s, i) => (
        <fieldset key={i} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}>
          <legend>{`Series ${i + 1}`}</legend>
          <Field
            label="Name"
            value={s.name ?? ''}
            onCommit={(t) => series(i, { name: t || undefined })}
            placeholder="Sheet1!$B$1 or a text"
          />
          <Field
            label="Values"
            value={s.values}
            onCommit={(t) => series(i, { values: t })}
            placeholder="Sheet1!$B$2:$B$13"
          />
          <Field
            label="Categories"
            value={s.categories ?? ''}
            onCommit={(t) => series(i, { categories: t || undefined })}
            placeholder="Sheet1!$A$2:$A$13"
          />
          {spec.data.series.length > 1 && (
            <Button
              size="small"
              variant="danger"
              onClick={() =>
                change({
                  data: { ...spec.data, series: spec.data.series.filter((_, j) => j !== i) },
                })
              }
            >
              {`Remove series ${i + 1}`}
            </Button>
          )}
        </fieldset>
      ))}
      <Button
        size="small"
        onClick={() =>
          change({
            data: {
              ...spec.data,
              series: [
                ...spec.data.series,
                { values: spec.data.series[spec.data.series.length - 1].values },
              ],
            },
          })
        }
      >
        Add series
      </Button>
      <FormControl>
        <FormControl.Label>Legend</FormControl.Label>
        <Select
          size="small"
          block
          value={spec.legend}
          onChange={(e) => change({ legend: e.target.value as ChartSpec['legend'] })}
        >
          {LEGENDS.map((l) => (
            <Select.Option key={l} value={l}>
              {l}
            </Select.Option>
          ))}
        </Select>
      </FormControl>
      <Field
        label="X axis title"
        value={spec.axes?.x?.title ?? ''}
        onCommit={(t) => axis('x', { title: t })}
      />
      <Field
        label="Y axis title"
        value={spec.axes?.y?.title ?? ''}
        onCommit={(t) => axis('y', { title: t })}
      />
      <Field
        label="Y axis minimum"
        value={spec.axes?.y?.min === undefined ? '' : String(spec.axes.y.min)}
        onCommit={(t) => axis('y', { min: number(t) })}
      />
      <Field
        label="Y axis maximum"
        value={spec.axes?.y?.max === undefined ? '' : String(spec.axes.y.max)}
        onCommit={(t) => axis('y', { max: number(t) })}
      />
      {spec.type === 'combo' && (
        <Field
          label="Secondary axis title"
          value={spec.axes?.y2?.title ?? ''}
          onCommit={(t) => axis('y2', { title: t })}
        />
      )}
      <FormControl>
        <Checkbox
          checked={spec.labels === true}
          onChange={(e) => change({ labels: e.target.checked || undefined })}
        />
        <FormControl.Label>Data labels</FormControl.Label>
      </FormControl>
    </div>
  );
}
