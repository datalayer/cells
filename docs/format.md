# The file format: `CellsWorkbook`

A workbook is saved as `CellsWorkbook` JSON (`model.toJSON()`,
`createCellsModel({ data })`, `datalayer_cells.Workbook` in Python): sparse,
readable, and validated whole before it touches a model.

```json
{
  "version": 1,
  "sheets": [
    {
      "id": "s1",
      "name": "Budget",
      "rows": {
        "0": { "cells": { "0": { "v": "Item", "s": 1 }, "1": { "v": "Total", "s": 1 } } },
        "1": { "cells": { "0": { "v": "Apples" }, "1": { "f": "B3*C3", "v": 1.5 } } }
      },
      "sizes": { "cols": { "0": 160 } },
      "hidden": { "rows": [7] },
      "merges": [{ "top": 0, "left": 0, "bottom": 0, "right": 2 }],
      "frozen": { "rows": 1, "cols": 0 },
      "charts": { "c1": { "id": "c1", "type": "column", "anchor": { "kind": "absolute", "x": 0, "y": 0, "width": 400, "height": 300 }, "data": { "series": [{ "values": "Budget!$B$2:$B$5" }], "by": "columns", "headers": { "row": true, "column": false }, "blanks": "gap" }, "legend": "bottom" } },
      "dataSource": { "id": "orders", "row": 2, "col": 1, "rows": 10000000, "cols": 4 }
    }
  ],
  "styles": [{}, { "bold": true }]
}
```

- **Cells** are keyed by row, then column index (0-based, as strings). `v`
  is the value (a number, a string, a boolean, `null`, or `{ "error": "#N/A" }`);
  `f` is a formula in A1 notation as typed, without the `=`, and `v` beside it
  its cached value, recomputed on load rather than trusted; `s` indexes
  `styles`.
- **Styles** are a table; index 0 is the default style. A style's keys are
  `font`, `size`, `bold`, `italic`, `underline`, `strike`, `color`, `fill`,
  `align`, `valign`, `wrap`, `borders`, `format` (an Excel number format) and
  `type` (a cell type's id: `checkbox`, `link`, `progress`, or a plugin's).
- **Charts** are specs by id (`ChartSpec`, see the API page); their ranges
  are A1 references.
- **A data source** binding names a `datalayer.cells.dataSource` contribution,
  the cell its first row lands on, and its shape. Its rows are read from the
  source when the workbook is shown; they are never in the file.

## Validation

Loading checks the whole file before it changes anything, and refuses a file
that does not match with a sentence naming the path of the first bad field:

```
sheets[0].rows["12"].cells["3"].s: no style 41
```

The TypeScript loader (`validateWorkbook`) and the Python one
(`datalayer_cells.validate_workbook`) refuse the same files with the same
sentences: both read the shared corpus in `tests/format/`.

## Versions

The format's version is `1` (`FORMAT_VERSION`). A file of any other version
is refused with a sentence; there is no migration in 1.0, and none is
needed: version 1 is the only version there has been. Fields added in a
1.x release (a style's `type`, a sheet's `dataSource`) keep the version at 1;
a file that uses one needs a reader of that release, since the loader refuses
fields it does not know. When a change needs a new version, the loader will
migrate forward only, one version at a time, each migration with its test.
