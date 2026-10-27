# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Datalayer Cells for Python: read and write Cells workbooks, as agents do.

The ``CellsWorkbook`` JSON format with the same validation as
``@datalayer/cells``, and the ``datalayer cells`` command. Live rooms
(the Loro schema) come with the collaboration milestone.
"""

from .__version__ import __version__
from .format import CELL_ERRORS, FORMAT_VERSION, FormatError, validate_workbook
from .workbook import Workbook, column_index, column_letters, parse_a1, parse_input, parse_zone

__all__ = [
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
]
