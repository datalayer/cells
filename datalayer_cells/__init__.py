# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Datalayer Cells for Python: read and write Cells workbooks, as agents do.

The ``CellsWorkbook`` JSON format with the same validation as
``@datalayer/cells``, and the ``datalayer cells`` command. Live rooms
(the Loro schema) come with the collaboration milestone.
"""

from .__version__ import __version__
from .charts import (
    BUILTIN_CHART_TYPES,
    CHART_VARIANTS,
    MAX_CHART_POINTS,
    ChartRefusal,
    chart_problem,
    check_chart,
    infer_chart_data,
    ref_zone,
    zone_ref,
)
from .format import CELL_ERRORS, FORMAT_VERSION, FormatError, check_code, validate_workbook
from .workbook import Workbook, column_index, column_letters, parse_a1, parse_input, parse_zone
from .live import JsonStore, LiveWorkbook, LoroStore, SpillError
from .transport import COMM_TARGET, CommTransport, RoomClient, current, register_comm_target


class _Cells:
    """``from datalayer_cells import cells``: the workbook this kernel is bound to, connected on first use.

    Inside a Jupyter kernel the page opens the ``datalayer.cells`` comm (its target
    is registered on import); ``join(url, room, token)`` binds a room instead.
    """

    _workbook: LiveWorkbook | None = None

    def _bound(self) -> LiveWorkbook:
        if self._workbook is None:
            transport = current()
            if transport is None:
                raise RuntimeError(
                    "No workbook is bound to this kernel: the page opens the datalayer.cells comm when it runs a code cell, or call datalayer_cells.join(url, room, token)."
                )
            self._workbook = transport.workbook
        return self._workbook

    def bind(self, workbook: LiveWorkbook) -> None:
        """Bind a workbook by hand (a room's, a test's)."""
        self._workbook = workbook

    def __getitem__(self, ref: str):
        return self._bound()[ref]

    def __setitem__(self, ref: str, value) -> None:
        self._bound()[ref] = value

    def __getattr__(self, name: str):
        return getattr(self._bound(), name)


#: The workbook this kernel is bound to.
cells = _Cells()


def join(url: str, room: str, token: str | None = None, timeout: float = 10.0) -> LiveWorkbook:
    """Join a room over the rooms' websocket as a peer and bind ``cells`` to it."""
    client = RoomClient(url, room, token)
    client.wait(timeout)
    workbook = LiveWorkbook(client.store)
    workbook.room = client  # type: ignore[attr-defined]
    cells.bind(workbook)
    return workbook


def connect() -> LiveWorkbook:
    """The workbook the page bound over the comm (``cells`` does this on first use)."""
    return cells._bound()


register_comm_target()

__all__ = [
    "BUILTIN_CHART_TYPES",
    "CHART_VARIANTS",
    "MAX_CHART_POINTS",
    "ChartRefusal",
    "chart_problem",
    "check_chart",
    "check_code",
    "infer_chart_data",
    "ref_zone",
    "zone_ref",
    "CELL_ERRORS",
    "FORMAT_VERSION",
    "FormatError",
    "Workbook",
    "__version__",
    "column_index",
    "column_letters",
    "parse_a1",
    "parse_input",
    "parse_zone",
    "validate_workbook",
    "COMM_TARGET",
    "CommTransport",
    "JsonStore",
    "LiveWorkbook",
    "LoroStore",
    "RoomClient",
    "SpillError",
    "cells",
    "connect",
    "current",
    "join",
    "register_comm_target",
]
