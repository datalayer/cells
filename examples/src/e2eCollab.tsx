/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The two-page collaboration test page (C6-04): one user, one grid, joined to
 * one room of a rooms server (`scripts/collab-server.mjs`), named in the URL:
 * `e2e-collab.html?ws=ws://127.0.0.1:1236&room=r1&name=Ada&color=%230969da`.
 * Two pages open it as two users. Not linked from the examples' menu.
 *
 * For the collab budget (§4, `collab.remotePaintMs`), the page stamps every
 * websocket message as it arrives (before the provider reads it), and
 * `cellsCollab.paintAfter(test)` resolves with the time from the arrival of
 * the message that made `test` true to the end of the frame that painted it.
 */

import { type CellsHandle, type CellsModel, createCellsModel, Spreadsheet } from '@datalayer/cells';
import { bindRoom } from '@datalayer/cells/collab';
import { LoroDoc } from 'loro-crdt';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Stamp each message before any other listener: the provider's own come later.
let lastArrival = 0;
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', () => {
      lastArrival = performance.now();
    });
  }
} as typeof WebSocket;

const query = new URLSearchParams(window.location.search);
const user = { name: query.get('name') ?? 'Ada', color: query.get('color') ?? '#0969da' };
const model = createCellsModel({ limits: { rows: 1000, cols: 26 } });
let handle: CellsHandle | null = null;

/**
 * Wait until `test()` holds after a change from the room (a document update or
 * a peer's presence), then for the frame after the renderer's: the ms from the
 * arrival of that change's message to then. The renderer listens first, so its
 * frame callback runs before this one in the same frame.
 */
function paintAfter(test: (m: CellsModel) => boolean, timeout = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`paintAfter: not seen within ${timeout} ms`));
    }, timeout);
    const check = () => {
      if (!test(model)) return;
      const arrival = lastArrival;
      stop();
      clearTimeout(timer);
      requestAnimationFrame(() => resolve(performance.now() - arrival));
    };
    const a = model.subscribe(check);
    const b = model.subscribePresence(check);
    const stop = () => {
      a();
      b();
    };
  });
}

const ready = bindRoom(model, {
  url: query.get('ws') ?? 'ws://127.0.0.1:1236',
  room: query.get('room') ?? 'cells-e2e',
  doc: new LoroDoc(),
  peer: user.name,
  user,
}).then(() => true);

(window as unknown as { cellsCollab: unknown }).cellsCollab = {
  model,
  user,
  ready,
  paintAfter,
  stats: () => handle?.renderStats(),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <h1>{`Cells collaboration test page: ${user.name}`}</h1>
    <div style={{ height: 400, position: 'relative' }}>
      <Spreadsheet
        ref={(h) => {
          handle = h;
        }}
        model={model}
        aria-label={`Sheet of ${user.name}`}
      />
    </div>
  </StrictMode>,
);
