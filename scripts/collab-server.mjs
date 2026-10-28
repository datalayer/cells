/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The rooms server of the collaboration example (C6-01): lexical-loro's
 * `ws` room handling from its Lexical-free `transport/server` entry, with no
 * seeder, so a Cells room starts empty and the first peer seeds it.
 *
 *     node scripts/collab-server.mjs            # ws://127.0.0.1:1236/<room>
 *     PORT=1240 HOST=0.0.0.0 node scripts/collab-server.mjs
 *
 * Then open the examples (`make examples`), the Collaboration page, and
 * connect both panes to ws://127.0.0.1:1236; or open the page in two windows.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from '@datalayer/lexical-loro/lib/collab/loro/transport/server.js';

export function startRoomsServer({ port = 1236, host = '127.0.0.1' } = {}) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Datalayer Cells rooms: connect a websocket to /<room>.\n');
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', setupWSConnection);
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const url = `ws://${host}:${typeof address === 'object' && address ? address.port : port}`;
      resolve({
        url,
        close: () =>
          new Promise((done) => {
            wss.clients.forEach((client) => client.terminate());
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { url } = await startRoomsServer({
    port: Number(process.env.PORT ?? 1236),
    host: process.env.HOST ?? '127.0.0.1',
  });
  console.log(`Datalayer Cells rooms: ${url}/<room>`);
}
