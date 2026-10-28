# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""The Python loader against the corpus the TypeScript loader reads (tests/format)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from datalayer_cells import FormatError, Workbook, validate_workbook

FORMAT = Path(__file__).resolve().parent.parent / "format"
WORKBOOKS = sorted((FORMAT / "workbooks").glob("*.json"))
MALFORMED = json.loads((FORMAT / "malformed.json").read_text(encoding="utf-8"))["cases"]


def test_the_corpus_is_there():
    assert len(WORKBOOKS) == 7  # six of C1-06 and the charts workbook of C10-07
    assert len(MALFORMED) >= 17


@pytest.mark.parametrize("path", WORKBOOKS, ids=lambda p: p.stem)
def test_round_trips_the_corpus_unchanged(path: Path, tmp_path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    wb = Workbook(data)
    assert wb.to_json() == data
    out = tmp_path / "copy.cells.json"
    wb.save(out)
    assert Workbook.load(out).to_json() == data


@pytest.mark.parametrize("case", MALFORMED, ids=lambda c: c["name"])
def test_refuses_what_typescript_refuses_with_the_same_sentence(case):
    with pytest.raises(FormatError) as error:
        validate_workbook(case["data"])
    assert re.search(case["message"], str(error.value)), str(error.value)
    with pytest.raises(FormatError):
        Workbook(case["data"])
