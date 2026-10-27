/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { FUNCTIONS } from '../index.js';
import { functionsPage } from '../page.js';

describe('the functions page', () => {
  it('is what the functions say (npm run functions-page writes it)', async () => {
    const target = fileURLToPath(new URL('../../../../docs/functions.md', import.meta.url));
    const page = await format(functionsPage(FUNCTIONS), {
      ...(await resolveConfig(target)),
      filepath: target,
    });
    expect(readFileSync(target, 'utf8')).toBe(page);
  });
});
