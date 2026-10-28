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
import { EphemeralStore, type LoroDoc } from 'loro-crdt';
import type { CellsModel } from '../core/model.js';
import { CellsCollabProvider } from '../points/index.js';
import { type BindingOptions, LoroBinding, type PresenceIds } from './binding.js';
import type { RemotePeer } from '../core/model.js';

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
  // An ephemeral store of this room's own: the provider's default is one store shared by every
  // provider of the process, which makes two peers in one page share one presence.
  const provider = new WebsocketProvider(options.url, options.room, options.doc, {
    ephemeralStore: new EphemeralStore(300_000),
    ...(options.WebSocketPolyfill !== undefined
      ? { WebSocketPolyfill: options.WebSocketPolyfill as typeof WebSocket }
      : {}),
  }) as unknown as RoomProvider;
  if (options.user !== undefined && provider.awareness !== null) {
    // lexical-loro's UserState keeps name and color at the top level; `user` is Cells' own field.
    provider.awareness.setLocalStateField('name', options.user.name);
    provider.awareness.setLocalStateField('color', options.user.color);
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

/**
 * Presence (§3.9): the local selection, the cell being edited and the
 * selected chart go into the awareness as the `cells` field, in id form;
 * the other peers' states come back as the model's `remotePresence`, at
 * this peer's positions. Returns the function that stops it.
 */
export function publishPresence(model: CellsModel, room: Room, binding: LoroBinding): () => void {
  const awareness = room.provider.awareness;
  if (awareness === null) return () => undefined;
  let last = '';
  const local = () => {
    const edit = model.edit;
    const ids = binding.selectionToIds(model.selection);
    const state = {
      ...ids,
      ...(edit !== null && edit.sheet === model.selection.sheet
        ? {
            editing: binding.selectionToIds({
              ...model.selection,
              active: { row: edit.row, col: edit.col },
            }).active,
          }
        : {}),
      ...(model.selectedChart !== null ? { chart: model.selectedChart } : {}),
    };
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    awareness.setLocalStateField('cells', state);
  };
  const remote = () => {
    const peers: RemotePeer[] = [];
    const localId = (awareness as unknown as { localClientId?: number }).localClientId;
    for (const [id, state] of awareness.getStates()) {
      if (localId !== undefined && id === localId) continue;
      const cells = state.cells as
        (PresenceIds & { editing?: readonly [string, string]; chart?: string }) | undefined;
      const user = (state.user as { name?: string; color?: string } | undefined) ?? {
        name: typeof state.name === 'string' ? state.name : undefined,
        color: typeof state.color === 'string' ? state.color : undefined,
      };
      if (cells === undefined) continue;
      const selection = binding.selectionFromIds(cells);
      if (selection === undefined) continue;
      const editing =
        cells.editing === undefined
          ? undefined
          : binding.selectionFromIds({
              sheet: cells.sheet,
              zones: cells.zones,
              active: cells.editing,
            })?.active;
      peers.push({
        id: String(id),
        user: { name: user?.name ?? `Peer ${id}`, color: user?.color ?? '#8250df' },
        sheet: selection.sheet,
        zones: selection.zones,
        active: selection.active,
        ...(editing !== undefined ? { editing } : {}),
        ...(cells.chart !== undefined ? { chart: cells.chart } : {}),
      });
    }
    model.setRemotePresence(peers);
  };
  local();
  const stops = [
    model.subscribeSelection(local),
    model.subscribeEdit(local),
    model.subscribe(remote),
  ];
  awareness.on('update', remote);
  remote();
  return () => {
    for (const s of stops) s();
    awareness.off('update', remote);
    model.setRemotePresence([]);
  };
}

/** A model bound to a room: joined, synced, then bound, its presence published. */
export async function bindRoom(
  model: CellsModel,
  options: RoomOptions & Pick<BindingOptions, 'peer'>,
): Promise<{ room: Room; binding: LoroBinding; stopPresence: () => void }> {
  const room = await joinRoom(options);
  const binding = new LoroBinding(model, options.doc, { peer: options.peer });
  const stopPresence = publishPresence(model, room, binding);
  return { room, binding, stopPresence };
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
