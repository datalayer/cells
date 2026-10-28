/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** What every example shares: the "coming soon" notes, and a frame for a grid. */

import { Flash } from '@primer/react';
import type { ReactNode } from 'react';

/**
 * Says what is not built yet (no plan ids: the site is public): Primer's warning flash, in the
 * site's theme. (primer-addons' CloseableFlash, the same Flash with a close button, logs React
 * warnings for `justifyContent` and `alignItems` on its inner Box in Primer 38.)
 */
export function Soon({ children }: { children: ReactNode }) {
  return (
    <Flash variant="warning" className="soon">
      <strong>Coming soon:</strong> {children}
    </Flash>
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
