/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { fromRows, Spreadsheet } from '@datalayer/cells';
import { Frame } from '../shared';

/** The smallest grid: a few values, uncontrolled. Click it, then move with the arrows, Tab and Enter. */
export default function Minimal() {
  return (
    <Frame>
      <Spreadsheet
        aria-label="Fruit"
        defaultData={fromRows([
          ['Item', 'Qty', 'Price'],
          ['Apples', 3, 0.5],
          ['Pears', 2, 0.75],
          ['Plums', 12, 0.2],
        ])}
      />
    </Frame>
  );
}
