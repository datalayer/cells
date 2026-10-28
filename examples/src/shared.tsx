/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** What every example shares: a frame for a grid. */

import type { ReactNode } from 'react';

/** A grid needs a sized parent: it fills it. */
export function Frame({ height = 320, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="frame" style={{ height }}>
      {children}
    </div>
  );
}
