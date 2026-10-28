/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The toolbar's *Insert chart* picker (§3.12): a Primer `ActionMenu` of the
 * chart types, each running `cells.chart.insert` with that type on the
 * grid's selection.
 *
 * @module chrome/ChartTypePicker
 */

import { ActionList, ActionMenu, ThemeProvider } from '@primer/react';
import { chartTypeChoices } from './ChartPanel.js';
import { useCells } from '../react/hooks.js';

export interface ChartTypePickerProps {
  readonly onError?: (message: string) => void;
}

export function ChartTypePicker(props: ChartTypePickerProps) {
  const model = useCells();
  const choices = chartTypeChoices(model);
  // A prop-less Primer ThemeProvider: the host's theme when there is one, Primer's default otherwise.
  return (
    <ThemeProvider>
      <ActionMenu>
        <ActionMenu.Button size="small" variant="invisible" data-cells-chart-picker="">
          Insert chart
        </ActionMenu.Button>
        <ActionMenu.Overlay width="small">
          <ActionList>
            {choices.map((t) => (
              <ActionList.Item
                key={t.id}
                data-chart-type={t.id}
                onSelect={() => {
                  model.reactor
                    .executeCommand('cells.chart.insert', { model, chartType: t.id })
                    .catch((error: Error) => props.onError?.(error.message));
                }}
              >
                {t.label}
              </ActionList.Item>
            ))}
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
    </ThemeProvider>
  );
}
