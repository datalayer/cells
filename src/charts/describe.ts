/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A chart in words, for a screen reader (§3.12): its name ("Column chart of
 * North by Month") and a description of its series ("2 series, 4 categories
 * from Jan to Apr; North runs from 10 to 15, highest in Mar"). Plain
 * sentences, so they can be translated as the messages of §3.7 are.
 *
 * @module charts/describe
 */

import type { ChartData, ChartSpec } from '../core/charts.js';

/** The generated name of a chart: its title, or "<Type> chart of <series> by <categories>". */
export function chartName(spec: ChartSpec, data: ChartData, label: string): string {
  if (spec.title !== undefined && spec.title !== '') return spec.title;
  const names = data.series.map((s) => s.name);
  const of =
    names.length === 0 ? '' : names.length === 1 ? ` of ${names[0]}` : ` of ${names.length} series`;
  return `${label} chart${of}`;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

/** The description of a chart's data: how many series and categories, and each series' range. */
export function describeChart(spec: ChartSpec, data: ChartData): string {
  if (data.deleted.length > 0)
    return `The data of this chart was deleted (${data.deleted.join(', ')}).`;
  const n = Math.max(0, ...data.series.map((s) => s.values.length));
  const parts: string[] = [];
  const head = `${data.series.length} series, ${n} ${spec.type === 'scatter' ? 'points' : 'categories'}`;
  if (data.categories.length > 0 && spec.type !== 'scatter')
    parts.push(
      `${head} from ${data.categories[0]} to ${data.categories[data.categories.length - 1]}`,
    );
  else parts.push(head);
  for (const s of data.series.slice(0, 8)) {
    const numbers = s.values.filter((v): v is number => v !== null);
    if (numbers.length === 0) {
      parts.push(`${s.name} holds no number`);
      continue;
    }
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const at = s.values.indexOf(max);
    const where =
      data.categories[at] !== undefined && spec.type !== 'scatter'
        ? `, highest in ${data.categories[at]}`
        : '';
    parts.push(`${s.name} runs from ${fmt(min)} to ${fmt(max)}${where}`);
  }
  if (data.series.length > 8) parts.push(`and ${data.series.length - 8} more`);
  return `${parts.join('; ')}.`;
}
