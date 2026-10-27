/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Start the examples' dev server on its fixed port and print the URL. Installs
 * nothing: dependencies come from the install (the monorepo root's, in the
 * Datalayer workspace). Stops with Ctrl+C.
 */

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const config = fileURLToPath(new URL('../examples/vite.config.ts', import.meta.url));
const server = await createServer({ configFile: config });
await server.listen();
const { port, host } = server.config.server;
console.log(`Datalayer Cells examples: http://${host}:${port}/`);
