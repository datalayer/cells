#!/usr/bin/env python3
# Copyright (c) 2022-2026 Datalayer, Inc.
#
# MIT License

"""Bump the version, in every file that carries a copy of it.

`datalayer_cells/__version__.py` is the source: hatch reads it. Every
`package.json` released with the same tag carries a copy (`@datalayer/cells`,
and the Docusaurus integration when it exists); a copy that gets missed ships
a package whose manifest disagrees with the tag that released it.

    python dev/bump_version.py patch     # 1.0.3 -> 1.0.4
    python dev/bump_version.py minor     # 1.0.3 -> 1.1.0
    python dev/bump_version.py major     # 1.0.3 -> 2.0.0
    python dev/bump_version.py           # asks

Nothing is written unless **every** file can be updated.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: The file the version is read from; hatch reads it too.
SOURCE = ROOT / "datalayer_cells" / "__version__.py"

#: The copies: every package.json released with the same tag.
COPIES: tuple[Path, ...] = tuple(
    path
    for path in (ROOT / "package.json", ROOT / "integrations" / "docusaurus" / "package.json")
    if path.exists()
)

PARTS = ("major", "minor", "patch")


class Unbumpable(Exception):
    """A file this script cannot update, named with what it expected."""


def read_version() -> str:
    match = re.search(r'__version__\s*=\s*"([^"]+)"', SOURCE.read_text())
    if match is None:
        raise Unbumpable(f'{SOURCE.relative_to(ROOT)} has no __version__ = "..."')
    for path in COPIES:
        copy = json.loads(path.read_text()).get("version")
        if copy != match.group(1):
            raise Unbumpable(
                f"{path.relative_to(ROOT)} carries {copy!r} but {SOURCE.relative_to(ROOT)} says "
                f"{match.group(1)!r}; make them agree by hand first"
            )
    return match.group(1)


def bump(version: str, part: str) -> str:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if match is None:
        raise Unbumpable(f"{version!r} is not major.minor.patch; bump it by hand")
    major, minor, patch = (int(value) for value in match.groups())
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def planned_edits(current: str, new: str) -> dict[Path, str]:
    escaped = re.escape(current)
    edits: dict[Path, str] = {}
    source = SOURCE.read_text()
    pattern = rf'(__version__\s*=\s*")({escaped})(")'
    if len(re.findall(pattern, source)) != 1:
        raise Unbumpable(f"{SOURCE.relative_to(ROOT)}: expected exactly one __version__ = \"{current}\"")
    edits[SOURCE] = re.sub(pattern, rf"\g<1>{new}\g<3>", source, count=1)
    for path in COPIES:
        text = path.read_text()
        pattern = rf'(^  "version"\s*:\s*")({escaped})(")'
        found = re.findall(pattern, text, flags=re.M)
        if len(found) != 1:
            raise Unbumpable(
                f"{path.relative_to(ROOT)}: expected exactly one \"version\": \"{current}\", found {len(found)}"
            )
        edits[path] = re.sub(pattern, rf"\g<1>{new}\g<3>", text, count=1, flags=re.M)
        json.loads(edits[path])
    return edits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("part", nargs="?", choices=PARTS, help="what to bump")
    parser.add_argument("--dry-run", action="store_true", help="say what would change and write nothing")
    arguments = parser.parse_args(argv)
    try:
        current = read_version()
        part = arguments.part
        while part is None:
            answer = input(f"Current version {current}. Which part? [major/minor/patch] ").strip().lower()
            part = answer if answer in PARTS else None
        new = bump(current, part)
        edits = planned_edits(current, new)
    except Unbumpable as error:
        print(f"Refused: {error}", file=sys.stderr)
        print("Nothing was written.", file=sys.stderr)
        return 1
    for path, text in sorted(edits.items()):
        if not arguments.dry_run:
            path.write_text(text)
        print(f"{'would bump' if arguments.dry_run else 'bumped'} {path.relative_to(ROOT)}")
    print(f"{current} -> {new}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
