/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  type CellsModel,
  CellsProvider,
  createCellsModel,
  Spreadsheet,
  toA1,
  useCellsModel,
  useCommand,
  useSelection,
} from '@datalayer/cells';
import { bindRoom, bridgeDocs, LoroBinding, type Room } from '@datalayer/cells/collab';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useRef, useState } from 'react';
import { Frame } from '../shared';

function Writer({ label }: { label: string }) {
  const set = useCommand('SET_CELLS');
  const selection = useSelection();
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        set({ sheet: selection.sheet, at: selection.active, cells: [[text]] });
        setText('');
      }}
    >
      <input
        aria-label={`Write into ${toA1(selection.active)}${label}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

const ROOM = 'cells-example';

/** The rooms server named in the page's URL (`#/collaboration?ws=ws://127.0.0.1:1236`), if any. */
function serverFromUrl(): string {
  const query = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('ws') ?? '';
}

/**
 * Two peers, each with its own model and Loro document (C6): bridged in this
 * page with no server, or both joined to one room on lexical-loro's `ws`
 * server (`node scripts/collab-server.mjs`, then connect to
 * ws://127.0.0.1:1236; or open the page in two windows). Each peer writes into
 * its own grid; the other sees it.
 */
export default function Collaboration() {
  const left = useCellsModel(() => createCellsModel({ limits: { rows: 1000, cols: 26 } }));
  const right = useCellsModel(() => createCellsModel({ limits: { rows: 1000, cols: 26 } }));
  const [url, setUrl] = useState(serverFromUrl);
  const [status, setStatus] = useState('bridged in this page');
  const [generation, setGeneration] = useState(0);
  const connected = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const disposers: (() => void)[] = [];
    const bind = (model: CellsModel, doc: LoroDoc, peer: string) => {
      const binding = new LoroBinding(model, doc, { peer });
      disposers.push(() => binding.dispose());
    };
    const target = connected.current;
    if (target === null) {
      const a = new LoroDoc();
      const b = new LoroDoc();
      disposers.push(bridgeDocs(a, b));
      bind(left, a, 'left');
      bind(right, b, 'right');
      setStatus('bridged in this page');
    } else {
      setStatus(`joining ${target}/${ROOM}…`);
      const join = async (model: CellsModel, peer: string): Promise<Room> => {
        const { room, binding } = await bindRoom(model, {
          url: target,
          room: ROOM,
          doc: new LoroDoc(),
          peer,
          user: { name: peer, color: peer === 'left' ? '#0969da' : '#bf3989' },
        });
        disposers.push(
          () => binding.dispose(),
          () => room.leave(),
        );
        return room;
      };
      join(left, 'left')
        .then(() => join(right, 'right'))
        .then(() => {
          if (!stopped) setStatus(`both panes in ${target}/${ROOM}`);
        })
        .catch((error: Error) => {
          if (!stopped) setStatus(`could not join: ${error.message}`);
        });
    }
    return () => {
      stopped = true;
      for (const d of disposers.reverse()) d();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connected.current = url.trim() === '' ? null : url.trim();
          setGeneration((g) => g + 1);
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}
      >
        <label>
          Rooms server{' '}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://127.0.0.1:1236 (empty: bridged in this page)"
            size={40}
          />
        </label>
        <button type="submit">Connect</button>
        <span role="status">{status}</span>
      </form>
      <p>
        Two peers, each with its own model and Loro document. With no server they are bridged in
        this page; start <code>node scripts/collab-server.mjs</code> and connect to join one room on
        lexical-loro&apos;s websocket server, or open this page in two windows.
      </p>
      <div className="panes">
        <CellsProvider model={left}>
          <Writer label="" />
          <Frame height={260}>
            <Spreadsheet model={left} aria-label="Left pane" />
          </Frame>
        </CellsProvider>
        <CellsProvider model={right}>
          <Writer label=" (right)" />
          <Frame height={260}>
            <Spreadsheet model={right} aria-label="Right pane" />
          </Frame>
        </CellsProvider>
      </div>
    </>
  );
}
