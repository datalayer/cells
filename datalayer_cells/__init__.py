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
]
