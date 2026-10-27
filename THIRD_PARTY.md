# Third-party notices

Cells is written from scratch. Two spreadsheets were read for inspiration:

- [x-spreadsheet](https://github.com/myliang/x-spreadsheet) (MIT, © 2017
  myliang). No line of it is copied today; any line ever taken is listed here
  with its notice kept in the file.
- [o-spreadsheet](https://github.com/odoo/o-spreadsheet) (LGPLv3, © Odoo
  S.A.). Read for design ideas only: none of its code, tests, function
  implementations or file-format mappings is copied or transliterated.

Dependencies shipped with the package are listed below with their licences as
they are added.

## In the tests only (not in the package)

- DejaVu Sans and DejaVu Sans Bold (`tests/render/fonts`), © Bitstream and
  the DejaVu authors, under the Bitstream Vera licence (see
  `tests/render/fonts/LICENSE`): the font the canvas snapshot tests draw
  with, so the pixels do not depend on a machine's fonts.
