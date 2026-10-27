<!-- Generated from the functions' metadata by `npm run functions-page`; do not edit. -->

# Functions

Cells ships 117 functions. Each is checked against what LibreOffice computes (`tests/formula/golden.json`, made by `scripts/formula-golden.py`), except where Excel answers otherwise, as the golden file says case by case. A plugin adds its own through the `datalayer.cells.function` contribution point.

## Math

| Function                                           | What it does                                                                 | Example                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| `ABS(number)`                                      | The absolute value.                                                          | `=ABS(-3.5) → 3.5`                        |
| `CEILING(number, step)`                            | Rounds up to a multiple of a step.                                           | `=CEILING(2.3, 1) → 3`                    |
| `EXP(number)`                                      | e to a power.                                                                | `=EXP(1) → 2.718281828`                   |
| `FLOOR(number, step)`                              | Rounds down to a multiple of a step.                                         | `=FLOOR(2.7, 0.5) → 2.5`                  |
| `INT(number)`                                      | Rounds down to an integer.                                                   | `=INT(-2.5) → -3`                         |
| `LN(number)`                                       | The natural logarithm.                                                       | `=LN(10) → 2.302585093`                   |
| `LOG(number, [base])`                              | The logarithm in a base, 10 by default.                                      | `=LOG(8, 2) → 3`                          |
| `LOG10(number)`                                    | The logarithm in base 10.                                                    | `=LOG10(1000) → 3`                        |
| `MOD(number, divisor)`                             | The remainder, with the divisor’s sign.                                      | `=MOD(-10, 3) → 2`                        |
| `PI()`                                             | π.                                                                           | `=PI() → 3.141592654`                     |
| `POWER(number, power)`                             | A number raised to a power.                                                  | `=POWER(2, 10) → 1024`                    |
| `PRODUCT(number1, [number2, …])`                   | Multiplies numbers.                                                          | `=PRODUCT(2, 3, 4) → 24`                  |
| `RAND()`                                           | A random number from 0 to 1. Recalculated on every change.                   | `=RAND()`                                 |
| `RANDBETWEEN(low, high)`                           | A random integer between two, both included. Recalculated on every change.   | `=RANDBETWEEN(1, 6)`                      |
| `ROUND(number, digits)`                            | Rounds half away from zero.                                                  | `=ROUND(2.567, 2) → 2.57`                 |
| `ROUNDDOWN(number, digits)`                        | Rounds toward zero.                                                          | `=ROUNDDOWN(-2.129, 2) → -2.12`           |
| `ROUNDUP(number, digits)`                          | Rounds away from zero.                                                       | `=ROUNDUP(2.121, 2) → 2.13`               |
| `SIGN(number)`                                     | 1, 0 or -1, as the number’s sign.                                            | `=SIGN(-4) → -1`                          |
| `SQRT(number)`                                     | The square root.                                                             | `=SQRT(16) → 4`                           |
| `SUM(number1, [number2, …])`                       | Adds numbers and the numbers of ranges.                                      | `=SUM(1, 2, 3) → 6`                       |
| `SUMIF(range, criterion, [sum_range])`             | Adds the cells of a range (or of a range beside it) that meet a criterion.   | `=SUMIF(A1:A3, ">1") with 1, 2, 3 → 5`    |
| `SUMIFS(sum_range, range1, criterion1, [more, …])` | Adds the cells meeting every criterion.                                      | `=SUMIFS(C1:C3, A1:A3, "a", B1:B3, ">0")` |
| `SUMPRODUCT(array1, [array2, …])`                  | The sum of the products of matching cells; what is not a number counts as 0. | `=SUMPRODUCT({1,2},{3,4}) → 11`           |
| `TRUNC(number, [digits])`                          | Cuts the digits after a point.                                               | `=TRUNC(-2.5) → -2`                       |

## Statistics

| Function                                                   | What it does                                                                | Example                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| `AVERAGE(number1, [number2, …])`                           | The arithmetic mean.                                                        | `=AVERAGE(2, 4, 9) → 5`              |
| `AVERAGEIF(range, criterion, [average_range])`             | The mean of the cells meeting a criterion.                                  | `=AVERAGEIF(A1:A3, ">1")`            |
| `AVERAGEIFS(average_range, range1, criterion1, [more, …])` | The mean of the cells meeting every criterion.                              | `=AVERAGEIFS(C1:C3, A1:A3, "a")`     |
| `COUNT(value1, [value2, …])`                               | How many numbers there are.                                                 | `=COUNT(1, "a", 3) → 2`              |
| `COUNTA(value1, [value2, …])`                              | How many values there are (empty cells left out).                           | `=COUNTA("a", 1) → 2`                |
| `COUNTBLANK(range)`                                        | How many cells are empty (or hold empty text).                              | `=COUNTBLANK(A1:A3)`                 |
| `COUNTIF(range, criterion)`                                | How many cells meet a criterion.                                            | `=COUNTIF(A1:A3, ">=2")`             |
| `COUNTIFS(range1, criterion1, [more, …])`                  | How many cells meet every criterion.                                        | `=COUNTIFS(A1:A3, "a", B1:B3, ">0")` |
| `LARGE(array, k)`                                          | The k-th largest number.                                                    | `=LARGE({3,1,2}, 1) → 3`             |
| `MAX(number1, [number2, …])`                               | The largest number; 0 when there is none.                                   | `=MAX(4, -1, 7) → 7`                 |
| `MAXIFS(max_range, range1, criterion1, [more, …])`         | The largest of the cells meeting every criterion; 0 when none does.         | `=MAXIFS(B1:B3, A1:A3, "a")`         |
| `MEDIAN(number1, [number2, …])`                            | The middle number.                                                          | `=MEDIAN(1, 3, 2, 4) → 2.5`          |
| `MIN(number1, [number2, …])`                               | The smallest number; 0 when there is none.                                  | `=MIN(4, -1, 7) → -1`                |
| `MINIFS(min_range, range1, criterion1, [more, …])`         | The smallest of the cells meeting every criterion; 0 when none does.        | `=MINIFS(B1:B3, A1:A3, "a")`         |
| `MODE(number1, [number2, …])`                              | The most frequent number (the first, on a tie).                             | `=MODE(1, 2, 2, 3) → 2`              |
| `RANK(number, ref, [order])`                               | A number’s rank in a list: 1 for the largest, or the smallest with order 1. | `=RANK(3, {1,3,2}) → 1`              |
| `SMALL(array, k)`                                          | The k-th smallest number.                                                   | `=SMALL({3,1,2}, 1) → 1`             |
| `STDEV(number1, [number2, …])`                             | The standard deviation of a sample.                                         | `=STDEV(1, 2, 3, 4) → 1.290994449`   |
| `STDEVP(number1, [number2, …])`                            | The standard deviation of a population.                                     | `=STDEVP(1, 2, 3, 4) → 1.118033989`  |
| `VAR(number1, [number2, …])`                               | The variance of a sample.                                                   | `=VAR(1, 2, 3, 4) → 1.666666667`     |
| `VARP(number1, [number2, …])`                              | The variance of a population.                                               | `=VARP(1, 2, 3, 4) → 1.25`           |

## Logic

| Function                                         | What it does                                                                      | Example                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------- |
| `AND(logical1, [logical2, …])`                   | Whether every value is true.                                                      | `=AND(TRUE, 1 > 0) → TRUE`            |
| `FALSE()`                                        | FALSE.                                                                            | `=FALSE() → FALSE`                    |
| `IF(condition, then, [else])`                    | One value when the condition holds, another when it does not.                     | `=IF(2 > 1, "yes", "no") → yes`       |
| `IFERROR(value, otherwise)`                      | The value, or another when the value is an error.                                 | `=IFERROR(1/0, "none") → none`        |
| `IFNA(value, otherwise)`                         | The value, or another when the value is #N/A.                                     | `=IFNA(NA(), "none") → none`          |
| `IFS(condition1, value1, [more, …])`             | The value of the first condition that holds.                                      | `=IFS(1 > 2, "a", TRUE, "b") → b`     |
| `NOT(logical)`                                   | The opposite.                                                                     | `=NOT(TRUE) → FALSE`                  |
| `OR(logical1, [logical2, …])`                    | Whether any value is true.                                                        | `=OR(FALSE, 1 > 0) → TRUE`            |
| `SWITCH(expression, value1, result1, [more, …])` | The result paired with the first value equal to the expression, else the default. | `=SWITCH(2, 1, "a", 2, "b", "z") → b` |
| `TRUE()`                                         | TRUE.                                                                             | `=TRUE() → TRUE`                      |
| `XOR(logical1, [logical2, …])`                   | Whether an odd number of values are true.                                         | `=XOR(TRUE, TRUE, TRUE) → TRUE`       |

## Text

| Function                                               | What it does                                                    | Example                                    |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------ |
| `CHAR(code)`                                           | The character of a code (1–255).                                | `=CHAR(65) → A`                            |
| `CODE(text)`                                           | The code of the first character.                                | `=CODE("A") → 65`                          |
| `CONCAT(text1, [text2, …])`                            | Joins texts and the values of ranges.                           | `=CONCAT("a", 1, TRUE) → a1TRUE`           |
| `CONCATENATE(text1, [text2, …])`                       | Joins texts.                                                    | `=CONCATENATE("a", 1) → a1`                |
| `EXACT(text1, text2)`                                  | Whether two texts are the same, case included.                  | `=EXACT("a", "A") → FALSE`                 |
| `FIND(find, within, [start])`                          | Where a text is in another, case-sensitively.                   | `=FIND("r", "cherry") → 4`                 |
| `LEFT(text, [count])`                                  | The first characters.                                           | `=LEFT("Banana", 3) → Ban`                 |
| `LEN(text)`                                            | How many characters.                                            | `=LEN("abc") → 3`                          |
| `LOWER(text)`                                          | In lower case.                                                  | `=LOWER("Banana") → banana`                |
| `MID(text, start, count)`                              | Characters from a position.                                     | `=MID("Elderberry", 2, 4) → lder`          |
| `PROPER(text)`                                         | Each word capitalised.                                          | `=PROPER("hello wORLD") → Hello World`     |
| `REPLACE(text, start, count, new)`                     | Replaces characters at a position.                              | `=REPLACE("abcdef", 2, 3, "X") → aXef`     |
| `REPT(text, times)`                                    | A text repeated.                                                | `=REPT("ab", 3) → ababab`                  |
| `RIGHT(text, [count])`                                 | The last characters.                                            | `=RIGHT("Banana", 2) → na`                 |
| `SEARCH(find, within, [start])`                        | Where a text is in another, any case, with wildcards.           | `=SEARCH("R", "cherry") → 4`               |
| `SUBSTITUTE(text, old, new, [instance])`               | Replaces a text by another: every time, or its n-th occurrence. | `=SUBSTITUTE("a-b-c", "-", "+") → a+b+c`   |
| `TEXT(value, format)`                                  | A value shown in a number format.                               | `=TEXT(1234.5, "#,##0.00") → 1,234.50`     |
| `TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])` | Joins texts with a delimiter, empty ones left out or not.       | `=TEXTJOIN("-", TRUE, "a", "", "b") → a-b` |
| `TRIM(text)`                                           | Removes spaces at both ends and doubled spaces inside.          | `=TRIM("  a   b  ") → a b`                 |
| `UPPER(text)`                                          | In capitals.                                                    | `=UPPER("apple") → APPLE`                  |
| `VALUE(text)`                                          | Text read as a number (or a date).                              | `=VALUE("12.5") → 12.5`                    |

## Lookup and reference

| Function                                                                      | What it does                                                                                                                    | Example                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `CHOOSE(index, value1, [more, …])`                                            | The value at an index in a list.                                                                                                | `=CHOOSE(2, "x", "y", "z") → y`   |
| `COLUMN([reference])`                                                         | The column number of a reference, or of the formula’s cell.                                                                     | `=COLUMN(C7) → 3`                 |
| `COLUMNS(range)`                                                              | How many columns a range has.                                                                                                   | `=COLUMNS(A1:F10) → 6`            |
| `HLOOKUP(value, table, row, [approximate])`                                   | Looks a value up in a table’s first row and gives the cell of another row in its column.                                        | `=HLOOKUP(2, A1:F3, 3, FALSE)`    |
| `INDEX(range, row, [column])`                                                 | The cell at a row and column of a range; row 0 is a whole column, column 0 a whole row.                                         | `=INDEX(A1:C3, 2, 3)`             |
| `INDIRECT(reference, [a1])`                                                   | The reference a text names, such as "B3" or "Sheet2!A1:C4". Recalculated on every change.                                       | `=INDIRECT("F" & 3)`              |
| `MATCH(value, range, [type])`                                                 | Where a value is in a row or column: exactly (0), the last not above it (1, ascending), the last not below it (-1, descending). | `=MATCH("cherry", C1:C10, 0) → 3` |
| `OFFSET(reference, rows, columns, [height], [width])`                         | A reference moved by rows and columns, of a height and width. Recalculated on every change.                                     | `=SUM(OFFSET(A1, 1, 0, 3, 1))`    |
| `ROW([reference])`                                                            | The row number of a reference, or of the formula’s cell.                                                                        | `=ROW(C7) → 7`                    |
| `ROWS(range)`                                                                 | How many rows a range has.                                                                                                      | `=ROWS(A1:F10) → 10`              |
| `VLOOKUP(value, table, column, [approximate])`                                | Looks a value up in a table’s first column and gives the cell of another column on its row.                                     | `=VLOOKUP(3, A1:C10, 2, FALSE)`   |
| `XLOOKUP(value, lookup, result, [if_not_found], [match_mode], [search_mode])` | Looks a value up in a row or column and gives what is at the same place in another.                                             | `=XLOOKUP("fig", C1:C10, F1:F10)` |
| `XMATCH(value, range, [match_mode], [search_mode])`                           | Where a value is in a row or column, exactly by default.                                                                        | `=XMATCH(70, F1:F10) → 7`         |

## Date and time

| Function                              | What it does                                                                                                      | Example                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `DATE(year, month, day)`              | The date of a year, month and day; months and days past their end carry over.                                     | `=DATE(2024, 2, 29) → 45351`       |
| `DATEDIF(start, end, unit)`           | The years ("y"), months ("m"), days ("d") between two dates, or the days and months left over ("md", "ym", "yd"). | `=DATEDIF(45000, 45366, "m") → 12` |
| `DATEVALUE(text)`                     | Text read as a date.                                                                                              | `=DATEVALUE("2023-03-15") → 45000` |
| `DAY(date)`                           | The day of a date’s month.                                                                                        | `=DAY(45000) → 15`                 |
| `DAYS(end, start)`                    | How many days from one date to another.                                                                           | `=DAYS(45366, 45000) → 366`        |
| `EDATE(start, months)`                | The date some months before or after.                                                                             | `=EDATE(45000, 1) → 45031`         |
| `EOMONTH(start, months)`              | The last day of the month some months before or after.                                                            | `=EOMONTH(45000, 0) → 45016`       |
| `HOUR(time)`                          | The hour of a time, 0 to 23.                                                                                      | `=HOUR(0.75) → 18`                 |
| `MINUTE(time)`                        | The minute of a time.                                                                                             | `=MINUTE(0.7604166667) → 15`       |
| `MONTH(date)`                         | The month of a date, 1 to 12.                                                                                     | `=MONTH(45000) → 3`                |
| `NETWORKDAYS(start, end, [holidays])` | How many weekdays (Monday to Friday) from one date to another, both included, holidays left out.                  | `=NETWORKDAYS(45000, 45030) → 23`  |
| `NOW()`                               | The date and time now. Recalculated on every change.                                                              | `=NOW()`                           |
| `SECOND(time)`                        | The second of a time.                                                                                             | `=SECOND(0.5000115741) → 1`        |
| `TIME(hour, minute, second)`          | A time of day, as a fraction of a day.                                                                            | `=TIME(13, 30, 0) → 0.5625`        |
| `TODAY()`                             | Today’s date. Recalculated on every change.                                                                       | `=TODAY()`                         |
| `WEEKDAY(date, [type])`               | The day of the week: 1 Sunday to 7 Saturday (type 1), 1 Monday to 7 Sunday (2), 0 Monday to 6 Sunday (3).         | `=WEEKDAY(45000) → 4`              |
| `WEEKNUM(date, [type])`               | The week of the year, week 1 holding 1 January; weeks start on Sunday (type 1) or Monday (2).                     | `=WEEKNUM(45000) → 11`             |
| `YEAR(date)`                          | The year of a date.                                                                                               | `=YEAR(45000) → 2023`              |

## Information

| Function           | What it does                                      | Example                   |
| ------------------ | ------------------------------------------------- | ------------------------- |
| `ISBLANK(value)`   | Whether a cell is empty.                          | `=ISBLANK(Z99) → TRUE`    |
| `ISERR(value)`     | Whether a value is an error other than #N/A.      | `=ISERR(NA()) → FALSE`    |
| `ISERROR(value)`   | Whether a value is an error.                      | `=ISERROR(1/0) → TRUE`    |
| `ISLOGICAL(value)` | Whether a value is TRUE or FALSE.                 | `=ISLOGICAL(TRUE) → TRUE` |
| `ISNA(value)`      | Whether a value is #N/A.                          | `=ISNA(NA()) → TRUE`      |
| `ISNUMBER(value)`  | Whether a value is a number.                      | `=ISNUMBER(1) → TRUE`     |
| `ISTEXT(value)`    | Whether a value is text.                          | `=ISTEXT("a") → TRUE`     |
| `N(value)`         | A number as it is, TRUE as 1, anything else as 0. | `=N(TRUE) → 1`            |
| `NA()`             | The #N/A error: no value available.               | `=NA() → #N/A`            |
