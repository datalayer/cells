# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The two transports of the live workbook (§3.13, C11-09), both carrying the same Loro updates.

- ``RoomClient``: a room joined over the rooms' websocket (lexical-loro's protocol:
  ``query-snapshot`` answered by the raw snapshot bytes, ``{"type": "update",
  "update": [...]}`` both ways), as a second peer beside the page. For a server
  kernel that can reach the room. Runs its socket on a thread, so the kernel's
  own thread reads and writes the document as it likes.
- ``CommTransport``: the ``datalayer.cells`` Jupyter comm the page opens on the
  kernel it runs code on: the page sends the snapshot, then every update; the
  kernel sends its own back. With loro-py (``LoroStore``) the messages carry Loro
  bytes, base64; without it (the browser's Pyodide) the page sends ``CellsWorkbook``
  JSON and takes the kernel's writes back (``JsonStore``).
"""

from __future__ import annotations

import base64
import json
import threading
from typing import Any, Callable

from .live import JsonStore, LiveWorkbook, LoroStore, Store

try:  # pragma: no cover - depends on the environment
    import loro as _loro
except ImportError:  # pragma: no cover
    _loro = None

#: The comm target the page opens on the kernel.
COMM_TARGET = "datalayer.cells"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text)


class RoomClient:
    """A peer of a room on the rooms' websocket, holding a ``LoroStore``."""

    def __init__(self, url: str, room: str, token: str | None = None, store: LoroStore | None = None):
        if _loro is None:
            raise ImportError("Joining a room needs loro-py: pip install loro")
        try:
            import websockets  # noqa: F401
        except ImportError as error:
            raise ImportError("Joining a room needs websockets: pip install websockets") from error
        self.store = store or LoroStore()
        self.url = f"{url.rstrip('/')}/{room}" + (f"?token={token}" if token else "")
        self.synced = threading.Event()
        self.closed = threading.Event()
        self._loop = None
        self._ws = None
        self._thread = threading.Thread(target=self._run, name="datalayer-cells-room", daemon=True)
        self._sub = self.store.on_local_update(self._send_update)
        self._thread.start()

    # -- the thread

    def _run(self) -> None:
        import asyncio

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._session())
        finally:
            self.closed.set()
            self._loop.close()

    async def _session(self) -> None:
        import websockets

        async with websockets.connect(self.url, max_size=None) as ws:
            self._ws = ws
            await ws.send(json.dumps({"type": "query-snapshot", "docId": self.url, "clientId": str(self.store.doc.peer_id)}))
            async for message in ws:
                if self.closed.is_set():
                    break
                if isinstance(message, (bytes, bytearray)):
                    # The snapshot: what the room holds. Where the room stands, read before it is
                    # merged in; what this document holds beyond that goes back to the room.
                    snapshot = bytes(message)
                    theirs = _loro.LoroDoc.decode_import_blob_meta(snapshot, False).partial_end_vv
                    self.store.apply(snapshot)
                    missing = self.store.doc.export(_loro.ExportMode.Updates(from_=theirs))
                    if _loro.LoroDoc.decode_import_blob_meta(missing, False).change_num > 0:
                        await ws.send(json.dumps({"type": "update", "update": list(missing), "docId": self.url}))
                    self.synced.set()
                    continue
                try:
                    data = json.loads(message)
                except ValueError:
                    continue
                if data.get("type") == "update" and isinstance(data.get("update"), list):
                    self.store.apply(bytes(data["update"]))
        self._ws = None

    def _send_update(self, update: bytes) -> None:
        loop, ws = self._loop, self._ws
        if loop is None or ws is None or self.closed.is_set():
            return
        import asyncio

        message = json.dumps({"type": "update", "update": list(update), "docId": self.url})
        asyncio.run_coroutine_threadsafe(ws.send(message), loop)

    # -- the API

    def wait(self, timeout: float = 10.0) -> None:
        """Block until the room's snapshot is in."""
        if not self.synced.wait(timeout):
            raise TimeoutError(f"No snapshot from {self.url} within {timeout} s.")

    def close(self) -> None:
        """Leave the room."""
        self.closed.set()
        loop, ws = self._loop, self._ws
        if loop is not None and ws is not None:
            import asyncio

            asyncio.run_coroutine_threadsafe(ws.close(), loop)
        self._thread.join(timeout=5)


class CommTransport:
    """The kernel's side of the ``datalayer.cells`` comm: a store fed by the page, its writes sent back."""

    def __init__(self, comm: Any, open_data: dict[str, Any] | None = None):
        self.comm = comm
        self.store: Store
        mode = (open_data or {}).get("mode", "loro" if _loro is not None else "json")
        if mode == "loro" and _loro is not None:
            store = LoroStore()
            self.store = store
            self._sub = store.on_local_update(lambda update: self._send({"type": "update", "data": _b64(update)}))
        else:
            json_store = JsonStore()
            json_store.send = self._send
            self.store = json_store
        self.workbook = LiveWorkbook(self.store)
        comm.on_msg(self._on_msg)
        self._send({"type": "ready", "mode": "loro" if isinstance(self.store, LoroStore) else "json"})

    def _send(self, data: dict[str, Any]) -> None:
        self.comm.send(data)

    def _on_msg(self, msg: dict[str, Any]) -> None:
        data = msg.get("content", {}).get("data", {})
        kind = data.get("type")
        if isinstance(self.store, LoroStore):
            if kind in ("snapshot", "update") and isinstance(data.get("data"), str):
                self.store.apply(_unb64(data["data"]))
        elif kind in ("snapshot", "workbook") and isinstance(data.get("workbook"), dict):
            self.store.replace(data["workbook"])
        if kind == "undo-writes":
            self.workbook.undo_writes(data.get("origin"))


class FakeComm:
    """A comm for tests: what the kernel sends lands in ``sent``; ``deliver`` plays the page's messages."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._handler: Callable[[dict[str, Any]], None] | None = None

    def on_msg(self, handler: Callable[[dict[str, Any]], None]) -> None:
        self._handler = handler

    def send(self, data: dict[str, Any]) -> None:
        self.sent.append(data)

    def deliver(self, data: dict[str, Any]) -> None:
        if self._handler is not None:
            self._handler({"content": {"data": data}})


_current: dict[str, Any] = {"transport": None}


def _on_comm_open(comm: Any, open_msg: dict[str, Any]) -> None:
    data = open_msg.get("content", {}).get("data", {})
    _current["transport"] = CommTransport(comm, data if isinstance(data, dict) else {})


def register_comm_target(comm_manager: Any | None = None) -> bool:
    """Register the ``datalayer.cells`` comm target on the kernel (the package's import does it); ``False`` outside a kernel."""
    if comm_manager is None:
        try:
            from IPython import get_ipython

            ip = get_ipython()
            comm_manager = getattr(getattr(ip, "kernel", None), "comm_manager", None)
        except ImportError:
            comm_manager = None
    if comm_manager is None:
        return False
    comm_manager.register_target(COMM_TARGET, _on_comm_open)
    return True


def current() -> CommTransport | None:
    """The comm the page opened, once it did."""
    return _current["transport"]


__all__ = ["COMM_TARGET", "CommTransport", "FakeComm", "RoomClient", "current", "register_comm_target"]
