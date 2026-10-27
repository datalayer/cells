/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** What every example shares: the "coming in" notes, and a frame for a grid. */

import type { ReactNode } from 'react';

/** Says what is not built yet, and the milestone that brings it. */
export function Soon({ milestone, children }: { milestone: string; children: ReactNode }) {
  return (
    <p className="soon">
      <strong>Coming in {milestone}.</strong> {children}
    </p>
  );
}

/** A grid needs a sized parent: it fills it. */
export function Frame({ height = 320, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="frame" style={{ height }}>
      {children}
    </div>
  );
}
