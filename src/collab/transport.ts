/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The shared Loro transport (§3.9, C6-01): lexical-loro's websocket
 * provider and awareness, from its Lexical-free `transport` entry (since
 * `@datalayer/lexical-loro` 1.0.8), so no second provider is written here
 * and nothing of Lexical is loaded. The module is imported when a room is
 * first joined, so `./collab` costs nothing to a host that never connects.
 *
 * A room is joined in two steps: the provider syncs the document with the
 * room, then the {@link LoroBinding} is made on the synced document, so the
 * first peer seeds the room and every later one adopts what is there.
 *
 * @module collab/transport
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import type { LoroDoc } from 'loro-crdt';
import type { CellsModel } from '../core/model.js';
import { CellsCollabProvider } from '../points/index.js';
import { type BindingOptions, LoroBinding } from './binding.js';

/** What a peer says about itself, as the awareness carries it. */
export interface RoomUser {
  readonly name: string;
  readonly color: string;
}

export interface RoomOptions {
  /** The rooms server, `ws://127.0.0.1:1236` (`scripts/collab-server.mjs`), or a Spacer room's URL. */
  readonly url: string;
  readonly room: string;
  readonly doc: LoroDoc;
  readonly user?: RoomUser;
  /** The WebSocket class outside a browser (`ws` in Node). */
  readonly WebSocketPolyfill?: unknown;
  /** How long to wait for the first sync, ms; the default is 10 s. */
  readonly timeout?: number;
}

/** The provider's surface Cells uses; the rest is lexical-loro's. */
export interface RoomProvider {
  readonly awareness: {
    setLocalStateField(field: string, value: unknown): void;
    getStates(): Map<number, Record<string, unknown>>;
    on(type: 'update', cb: () => void): void;
    off(type: 'update', cb: () => void): void;
  } | null;
  readonly synced: boolean;
  on(type: string, cb: (...args: unknown[]) => void): void;
  off(type: string, cb: (...args: unknown[]) => void): void;
  disconnect(): void;
  destroy(): void;
}

export interface Room {
  readonly doc: LoroDoc;
  readonly provider: RoomProvider;
  /** Leave the room: the provider is destroyed, the document stays. */
  leave(): void;
}

/** The transport module, loaded once. */
async function transport() {
  return import('@datalayer/lexical-loro/lib/collab/loro/transport/index.js');
}

/**
 * Join a room: connect the document and resolve once the first sync is
 * through (or reject after `timeout`). The document then holds what the
 * room holds.
 */
export async function joinRoom(options: RoomOptions): Promise<Room> {
  const { WebsocketProvider } = await transport();
  const provider = new WebsocketProvider(options.url, options.room, options.doc, {
    ...(options.WebSocketPolyfill !== undefined
      ? { WebSocketPolyfill: options.WebSocketPolyfill as typeof WebSocket }
      : {}),
  }) as unknown as RoomProvider;
  if (options.user !== undefined && provider.awareness !== null) {
    provider.awareness.setLocalStateField('user', options.user);
  }
  const timeout = options.timeout ?? 10_000;
  await new Promise<void>((resolve, reject) => {
    if (provider.synced) return resolve();
    const timer = setTimeout(() => {
      provider.off('synced', onSynced);
      provider.destroy();
      reject(new Error(`No sync from ${options.url}/${options.room} within ${timeout} ms.`));
    }, timeout);
    function onSynced() {
      clearTimeout(timer);
      provider.off('synced', onSynced);
      resolve();
    }
    provider.on('synced', onSynced);
  });
  return {
    doc: options.doc,
    provider,
    leave: () => provider.destroy(),
  };
}

/** A model bound to a room: joined, synced, then bound. */
export async function bindRoom(
  model: CellsModel,
  options: RoomOptions & Pick<BindingOptions, 'peer'>,
): Promise<{ room: Room; binding: LoroBinding }> {
  const room = await joinRoom(options);
  const binding = new LoroBinding(model, options.doc, { peer: options.peer });
  return { room, binding };
}

export const CELLS_WS_COLLAB_PLUGIN = '@datalayer/cells-collab-ws';

/**
 * The collaboration provider as a Reactor plugin (`datalayer.cells.collabProvider`,
 * exactly one or none): rooms on a lexical-loro `ws` server at `url`.
 */
export function cellsWsCollabPlugin(url: string, user?: RoomUser) {
  return definePlugin({
    name: CELLS_WS_COLLAB_PLUGIN,
    displayName: 'Cells collaboration (websocket)',
    description: `Rooms on ${url}, over lexical-loro's transport.`,
    octicon: 'broadcast',
    contributes: [
      contribution(
        CellsCollabProvider,
        {
          id: 'lexical-loro-ws',
          connect: (doc: unknown, room: string) =>
            joinRoom({ url, room, doc: doc as LoroDoc, ...(user !== undefined ? { user } : {}) }),
        },
        { id: 'lexical-loro-ws' },
      ),
    ],
  });
}

/**
 * Two documents in one page, each other's peer with no server: every local
 * update of one is imported into the other. For the example and for tests;
 * returns the function that stops it.
 */
export function bridgeDocs(a: LoroDoc, b: LoroDoc): () => void {
  const stopA = a.subscribeLocalUpdates((update) => b.import(update));
  const stopB = b.subscribeLocalUpdates((update) => a.import(update));
  b.import(a.export({ mode: 'update' }));
  a.import(b.export({ mode: 'update' }));
  return () => {
    stopA();
    stopB();
  };
}
