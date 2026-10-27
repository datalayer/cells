# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""``datalayer cells``: read and write Cells workbooks from a terminal.

Two doors to the same commands, as Datalayer's other packages have:
installed beside the Datalayer CLI, the ``cells`` group joins the
``datalayer`` command through the ``datalayer.cli`` entry point; on its own,
``datalayer-cells`` runs it.

    datalayer cells show budget.cells.json            # the sheets and their used ranges
    datalayer cells get budget.cells.json 'Summary!A1:C4'
    datalayer cells set budget.cells.json B2 12 '=B1*2'
    datalayer cells export budget.cells.json --sheet Summary --format csv
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any, List, Optional

import typer
from reactor import PluginManifest

from .__version__ import __version__
from .format import FormatError
from .workbook import Workbook, column_letters, parse_input

app = typer.Typer(
    name="cells",
    help="Read and write Datalayer Cells workbooks (.cells.json).",
    no_args_is_help=True,
)


def _load(path: Path) -> Workbook:
    try:
        return Workbook.load(path)
    except (OSError, FormatError) as error:
        typer.echo(f"Cannot read {path}: {error}", err=True)
        raise typer.Exit(1) from error


def _show(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return str(value.get("error"))
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


@app.command()
def show(path: Path) -> None:
    """The sheets of a workbook, and the range each one uses."""
    wb = _load(path)
    for sheet in wb.to_json()["sheets"]:
        rows = [int(r) for r in sheet["rows"]]
        cols = [int(c) for row in sheet["rows"].values() for c in row["cells"]]
        used = f"A1:{column_letters(max(cols))}{max(rows) + 1}" if rows and cols else "empty"
        count = sum(len(row["cells"]) for row in sheet["rows"].values())
        typer.echo(f"{sheet['name']}\t{used}\t{count} cells")


@app.command()
def get(path: Path, ref: str, formulas: bool = typer.Option(False, "--formulas", help="Show formulas as typed.")) -> None:
    """The values (or formulas) of a range, tab-separated."""
    wb = _load(path)
    try:
        rows = wb.read(ref)
        typed = wb.formulas(ref) if formulas else None
    except (KeyError, ValueError) as error:
        typer.echo(str(error).strip('"'), err=True)
        raise typer.Exit(1) from error
    for r, row in enumerate(rows):
        typer.echo("\t".join(typed[r][c] or _show(v) if typed else _show(v) for c, v in enumerate(row)))


@app.command(name="set")
def set_(
    path: Path,
    ref: str,
    values: List[str] = typer.Argument(..., help="Values for a row from REF, typed as in a cell: 12, TRUE, =A1*2, 'text."),
) -> None:
    """Write a row of values from a cell, as typing them would, and save."""
    wb = _load(path)
    row: list[Any] = []
    for text in values:
        parsed = parse_input(text)
        row.append(f"={parsed['f']}" if "f" in parsed else parsed.get("v"))
    try:
        wb.write(ref, [row])
    except (KeyError, ValueError) as error:
        typer.echo(str(error).strip('"'), err=True)
        raise typer.Exit(1) from error
    wb.save(path)
    typer.echo(f"Wrote {len(row)} cell(s) from {ref}.")


@app.command()
def export(
    path: Path,
    sheet: Optional[str] = typer.Option(None, help="The sheet to export (the first by default)."),
    format: str = typer.Option("csv", help="csv or json."),
) -> None:
    """A sheet as CSV (values) or the workbook as canonical JSON, on standard output."""
    wb = _load(path)
    if format == "json":
        typer.echo(json.dumps(wb.to_json(), indent=2))
        return
    if format != "csv":
        typer.echo(f"No export format '{format}': csv or json.", err=True)
        raise typer.Exit(1)
    data = wb.to_json()
    names = [s["name"] for s in data["sheets"]]
    chosen = sheet or names[0]
    match = [s for s in data["sheets"] if s["name"].lower() == chosen.lower()]
    if not match:
        typer.echo(f"No sheet '{chosen}'; the workbook has {', '.join(names)}.", err=True)
        raise typer.Exit(1)
    rows = match[0]["rows"]
    if not rows:
        return
    height = max(int(r) for r in rows) + 1
    width = max(int(c) for row in rows.values() for c in row["cells"]) + 1
    quoted = "'" + match[0]["name"].replace("'", "''") + "'"
    values = wb.read(f"{quoted}!A1:{column_letters(width - 1)}{height}")
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows([[_show(v) for v in row] for row in values])
    typer.echo(out.getvalue(), nl=False)


@app.command()
def version() -> None:
    """The version of datalayer_cells."""
    typer.echo(__version__)


class CellsCliExtension:
    """The plugin: registers the ``cells`` group into the host CLI."""

    def provide_cli(self, cli: "typer.Typer") -> None:
        cli.add_typer(app, name="cells")


manifest = PluginManifest(
    name="cells-cli",
    version=__version__,
    description="The `cells` command group: show, get, set, export.",
    author="Datalayer",
    tags=["cli", "cells"],
)


def plugin() -> tuple[PluginManifest, CellsCliExtension]:
    """What the ``datalayer.cli`` entry point resolves to."""
    return manifest, CellsCliExtension()


def main() -> None:
    """The ``datalayer-cells`` console script: the same group, on its own."""
    app()
