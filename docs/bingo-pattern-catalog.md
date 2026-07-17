# Canonical Bingo Pattern Catalog

This document is the human-reviewable transcription of every diagram in the
four supplied pattern PDFs. Each source PDF has one page. A reference such as
`p1/d06` means page 1, diagram 6, counting left to right and then top to bottom.

Runtime canonical data lives in `packages/patterns/src/catalog.ts`. The core
section below is generated and tested from the runtime catalog so the two
representations cannot diverge. Later catalog stories add the remaining letter,
number, and Christmas exact entries to that canonical runtime data.

## Mask Notation

A mask has five top-to-bottom rows separated by `/`. Each row has five cells in
B, I, N, G, O column order. `#` means the source diagram marks the cell and `.`
means it does not. For example, `#...#/...../..#../...../#...#` marks the four
corners and center.

The center is the free square and is always satisfied. A center `#` preserves
the source diagram but never requires a player daub; a center `.` remains
unrequired. Blackout therefore requires all 24 noncenter cells even though the
source Full House diagram marks all 25 cells.

An `exact` pattern requires every `#` cell in its documented mask and tolerates
additional daubs. A `flexible-example` row records one diagram illustrating a
rule whose valid arrangements are calculated rather than represented by that
single source mask. An `alias` row accounts for source terminology that maps to
one runtime pattern instead of creating another selectable entry.

Never rotate, reflect, translate, or otherwise transform a source mask
implicitly. Every exact mask uses only the documented orientation and position.
A transformed pattern must have its own explicitly sourced catalog entry.

## Flexible Rules And Aliases

- **One Line:** Any one complete row, column, or corner-to-corner diagonal. The
  supplied PDFs contain no One Line diagram.
- **Two Lines:** Any two distinct complete rows, columns, or corner-to-corner
  diagonals, including intersecting lines. The shapes PDF supplies two examples
  of this one flexible rule; neither example limits the accepted combinations.
- **Blackout:** Every noncenter cell. `Full House` is only the source PDF alias
  for the single runtime and user-facing Blackout entry. Full House must never
  become a second selectable pattern.

<!-- prettier-ignore-start -->
<!-- BEGIN GENERATED CORE PATTERNS -->
| Stable ID | Name | Category | Version | Mode | Source | Masks | Mask digest |
| --------- | ---- | -------- | ------: | ---- | ------ | ----: | ----------- |
| `standard-one-line` | One Line | standard | 1 | `one-line` | Rule definition (no PDF diagram) | 12 | `3492b0e7da1646e3` |
| `standard-two-lines` | Two Lines | standard | 1 | `two-lines` | `docs/shapes-bingo-patterns.pdf` `p1/d02`, `p1/d25` | 66 | `ba76535978800bab` |
| `standard-blackout` | Blackout | standard | 1 | `blackout` | Full House alias at `docs/shapes-bingo-patterns.pdf` `p1/d06` | 1 | `47244f978d15f546` |
| `shape-bunny-ears` | Bunny Ears | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d01` | 1 | `a500d6260bbd0356` |
| `shape-four-corners` | Four Corners | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d03` | 1 | `1c30d141ce304da9` |
| `shape-windmill` | Windmill | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d04` | 1 | `8902e832037bbb26` |
| `shape-outside-edge` | Outside Edge | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d05` | 1 | `b2d9fba56458c581` |
| `shape-airplane` | Airplane | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d07` | 1 | `078956c81980abea` |
| `shape-wine-glass` | Wine Glass | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d08` | 1 | `9296ff77a5e657e6` |
| `shape-x` | X | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d09` | 1 | `72e71d8ab21ee4a6` |
| `shape-turtle` | Turtle | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d10` | 1 | `0a0292b032f209a9` |
| `shape-stairs` | Stairs | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d11` | 1 | `8de48cfa07d03362` |
| `shape-bow-tie` | Bow Tie | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d12` | 1 | `34377eb13c5b1b4e` |
| `shape-cross` | Cross | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d13` | 1 | `3c2cb612ae2b6996` |
| `shape-plus` | Plus | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d14` | 1 | `acb757b0546128e6` |
| `shape-rectangle` | Rectangle | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d15` | 1 | `8bc8695861d9a0a9` |
| `shape-heart` | Heart | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d16` | 1 | `9a5f2468c61a0d8d` |
| `shape-hat` | Hat | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d17` | 1 | `54d86cfe277d3236` |
| `shape-hour-glass` | Hour Glass | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d18` | 1 | `750876bae3dbe11e` |
| `shape-pyramid` | Pyramid | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d19` | 1 | `18645d7eaf818956` |
| `shape-checkerboard` | Checkerboard | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d20` | 1 | `81eb978df2da2a66` |
| `shape-inside-square` | Inside Square | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d21` | 1 | `e1cdf52d5b3df246` |
| `shape-kite` | Kite | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d22` | 1 | `a346e4fe365308d8` |
| `shape-smiley-face` | Smiley Face | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d23` | 1 | `9d9330f89afea90d` |
| `shape-block-of-nine` | Block of Nine | shape | 1 | `exact` | `docs/shapes-bingo-patterns.pdf` `p1/d24` | 1 | `f82f4f5710a22688` |
<!-- END GENERATED CORE PATTERNS -->
<!-- prettier-ignore-end -->

## Source Inventory

Every row records the source display mask, including flexible examples and alias
artwork. `Catalog name` is the future runtime/user-facing mapping; category-
specific stable IDs will keep separate entries distinct in the runtime catalog.

### `docs/shapes-bingo-patterns.pdf`

| Reference | Source name   | Mode             | Catalog name  | Source mask                     |
| --------- | ------------- | ---------------- | ------------- | ------------------------------- |
| `p1/d01`  | Bunny Ears    | exact            | Bunny Ears    | `.###./#.#.#/#.#.#/#.#.#/#.#.#` |
| `p1/d02`  | Two Lines     | flexible-example | Two Lines     | `#####/#..../#..../#..../#....` |
| `p1/d03`  | Four Corners  | exact            | Four Corners  | `#...#/...../...../...../#...#` |
| `p1/d04`  | Windmill      | exact            | Windmill      | `##.##/##.##/..#../##.##/##.##` |
| `p1/d05`  | Outside Edge  | exact            | Outside Edge  | `#####/#...#/#...#/#...#/#####` |
| `p1/d06`  | Full House    | alias            | Blackout      | `#####/#####/#####/#####/#####` |
| `p1/d07`  | Airplane      | exact            | Airplane      | `...#./#..#./#####/#..#./...#.` |
| `p1/d08`  | Wine Glass    | exact            | Wine Glass    | `#####/.###./..#../..#../.###.` |
| `p1/d09`  | X             | exact            | X             | `#...#/.#.#./..#../.#.#./#...#` |
| `p1/d10`  | Turtle        | exact            | Turtle        | `..#../#####/.###./.###./#...#` |
| `p1/d11`  | Stairs        | exact            | Stairs        | `....#/...##/..###/.####/#####` |
| `p1/d12`  | Bow Tie       | exact            | Bow Tie       | `...../##.##/#####/##.##/.....` |
| `p1/d13`  | Cross         | exact            | Cross         | `..#../#####/..#../..#../..#..` |
| `p1/d14`  | Plus          | exact            | Plus          | `..#../..#../#####/..#../..#..` |
| `p1/d15`  | Rectangle     | exact            | Rectangle     | `...../#####/#...#/#####/.....` |
| `p1/d16`  | Heart         | exact            | Heart         | `.#.#./#####/#####/.###./..#..` |
| `p1/d17`  | Hat           | exact            | Hat           | `...../.###./.###./#####/.....` |
| `p1/d18`  | Hour Glass    | exact            | Hour Glass    | `#####/.###./..#../.###./#####` |
| `p1/d19`  | Pyramid       | exact            | Pyramid       | `...../...../..#../.###./#####` |
| `p1/d20`  | Checkerboard  | exact            | Checkerboard  | `#.#.#/.#.#./#.#.#/.#.#./#.#.#` |
| `p1/d21`  | Inside Square | exact            | Inside Square | `...../.###./.###./.###./.....` |
| `p1/d22`  | Kite          | exact            | Kite          | `...##/...##/..#../.#.../#....` |
| `p1/d23`  | Smiley Face   | exact            | Smiley Face   | `...../.#.#./..#../#...#/.###.` |
| `p1/d24`  | Block of Nine | exact            | Block of Nine | `###../###../###../...../.....` |
| `p1/d25`  | Two Lines     | flexible-example | Two Lines     | `.#.#./.#.#./.#.#./.#.#./.#.#.` |

The two `Two Lines` rows are source examples for one flexible rule. The
`Full House` row is source-alias documentation for Blackout, not a separate
runtime or user-facing pattern.

### Shape Cell Review Records

Each record confirms that all 25 source cells were checked against the PDF and
the source inventory above. An `exact-mask-match` also confirms that the
canonical runtime mask matches those cells. Flexible examples and aliases retain
their reviewed source masks in the inventory while mapping to one calculated
rule or existing runtime entry rather than becoming exact selectable patterns.

| Reference | Source name   | Runtime ID            | Review                  | Cells reviewed |
| --------- | ------------- | --------------------- | ----------------------- | -------------: |
| `p1/d01`  | Bunny Ears    | `shape-bunny-ears`    | `exact-mask-match`      |          25/25 |
| `p1/d02`  | Two Lines     | `standard-two-lines`  | `flexible-rule-example` |          25/25 |
| `p1/d03`  | Four Corners  | `shape-four-corners`  | `exact-mask-match`      |          25/25 |
| `p1/d04`  | Windmill      | `shape-windmill`      | `exact-mask-match`      |          25/25 |
| `p1/d05`  | Outside Edge  | `shape-outside-edge`  | `exact-mask-match`      |          25/25 |
| `p1/d06`  | Full House    | `standard-blackout`   | `source-alias`          |          25/25 |
| `p1/d07`  | Airplane      | `shape-airplane`      | `exact-mask-match`      |          25/25 |
| `p1/d08`  | Wine Glass    | `shape-wine-glass`    | `exact-mask-match`      |          25/25 |
| `p1/d09`  | X             | `shape-x`             | `exact-mask-match`      |          25/25 |
| `p1/d10`  | Turtle        | `shape-turtle`        | `exact-mask-match`      |          25/25 |
| `p1/d11`  | Stairs        | `shape-stairs`        | `exact-mask-match`      |          25/25 |
| `p1/d12`  | Bow Tie       | `shape-bow-tie`       | `exact-mask-match`      |          25/25 |
| `p1/d13`  | Cross         | `shape-cross`         | `exact-mask-match`      |          25/25 |
| `p1/d14`  | Plus          | `shape-plus`          | `exact-mask-match`      |          25/25 |
| `p1/d15`  | Rectangle     | `shape-rectangle`     | `exact-mask-match`      |          25/25 |
| `p1/d16`  | Heart         | `shape-heart`         | `exact-mask-match`      |          25/25 |
| `p1/d17`  | Hat           | `shape-hat`           | `exact-mask-match`      |          25/25 |
| `p1/d18`  | Hour Glass    | `shape-hour-glass`    | `exact-mask-match`      |          25/25 |
| `p1/d19`  | Pyramid       | `shape-pyramid`       | `exact-mask-match`      |          25/25 |
| `p1/d20`  | Checkerboard  | `shape-checkerboard`  | `exact-mask-match`      |          25/25 |
| `p1/d21`  | Inside Square | `shape-inside-square` | `exact-mask-match`      |          25/25 |
| `p1/d22`  | Kite          | `shape-kite`          | `exact-mask-match`      |          25/25 |
| `p1/d23`  | Smiley Face   | `shape-smiley-face`   | `exact-mask-match`      |          25/25 |
| `p1/d24`  | Block of Nine | `shape-block-of-nine` | `exact-mask-match`      |          25/25 |
| `p1/d25`  | Two Lines     | `standard-two-lines`  | `flexible-rule-example` |          25/25 |

### `docs/letter-bingo-patterns.pdf`

| Reference | Source name | Mode  | Catalog name | Source mask                     |
| --------- | ----------- | ----- | ------------ | ------------------------------- |
| `p1/d01`  | A           | exact | A            | `#####/#...#/#####/#...#/#...#` |
| `p1/d02`  | B           | exact | B            | `####./#...#/####./#...#/####.` |
| `p1/d03`  | C           | exact | C            | `#####/#..../#..../#..../#####` |
| `p1/d04`  | D           | exact | D            | `####./#...#/#...#/#...#/####.` |
| `p1/d05`  | E           | exact | E            | `#####/#..../####./#..../#####` |
| `p1/d06`  | F           | exact | F            | `#####/#..../#####/#..../#....` |
| `p1/d07`  | G           | exact | G            | `#####/#..../#.###/#...#/#####` |
| `p1/d08`  | H           | exact | H            | `#...#/#...#/#####/#...#/#...#` |
| `p1/d09`  | I           | exact | I            | `#####/..#../..#../..#../#####` |
| `p1/d10`  | J           | exact | J            | `#####/....#/....#/....#/#####` |
| `p1/d11`  | K           | exact | K            | `#...#/#..#./###../#..#./#...#` |
| `p1/d12`  | L           | exact | L            | `#..../#..../#..../#..../#####` |
| `p1/d13`  | M           | exact | M            | `#...#/##.##/#.#.#/#...#/#...#` |
| `p1/d14`  | N           | exact | N            | `#...#/##..#/#.#.#/#..##/#...#` |
| `p1/d15`  | O           | exact | O            | `#####/#...#/#...#/#...#/#####` |
| `p1/d16`  | P           | exact | P            | `####./#...#/####./#..../#....` |
| `p1/d17`  | Q           | exact | Q            | `#####/#...#/#...#/#..##/#####` |
| `p1/d18`  | R           | exact | R            | `####./#...#/####./#..#./#...#` |
| `p1/d19`  | S           | exact | S            | `#####/#..../#####/....#/#####` |
| `p1/d20`  | T           | exact | T            | `#####/..#../..#../..#../..#..` |
| `p1/d21`  | U           | exact | U            | `#...#/#...#/#...#/#...#/#####` |
| `p1/d22`  | V           | exact | V            | `#...#/#...#/.#.#./.#.#./..#..` |
| `p1/d23`  | W           | exact | W            | `#...#/#...#/#.#.#/##.##/#...#` |
| `p1/d24`  | X           | exact | X            | `#...#/.#.#./..#../.#.#./#...#` |
| `p1/d25`  | Y           | exact | Y            | `#...#/.#.#./..#../..#../..#..` |

The source ends at Y; it contains no Z diagram. Q and W use the confirmed masks
shown above without rotation, reflection, translation, or typographic cleanup.

### `docs/number-bingo-patterns.pdf`

The PDF page heading says “Letters + numbers,” but its diagrams are the numbers
0 through 19 only.

| Reference | Source name | Mode  | Catalog name | Source mask                     |
| --------- | ----------- | ----- | ------------ | ------------------------------- |
| `p1/d01`  | 0           | exact | 0            | `.###./#..##/#.#.#/##..#/.###.` |
| `p1/d02`  | 1           | exact | 1            | `..#../.##../..#../..#../.###.` |
| `p1/d03`  | 2           | exact | 2            | `.###./#...#/..##./.#.../#####` |
| `p1/d04`  | 3           | exact | 3            | `.###./#...#/..##./#...#/.###.` |
| `p1/d05`  | 4           | exact | 4            | `#...#/#...#/#####/....#/....#` |
| `p1/d06`  | 5           | exact | 5            | `#####/#..../####./....#/####.` |
| `p1/d07`  | 6           | exact | 6            | `.###./#..../####./#...#/.###.` |
| `p1/d08`  | 7           | exact | 7            | `#####/#...#/...#./..#../..#..` |
| `p1/d09`  | 8           | exact | 8            | `.###./#...#/.###./#...#/.###.` |
| `p1/d10`  | 9           | exact | 9            | `.###./#...#/.####/....#/.###.` |
| `p1/d11`  | 10          | exact | 10           | `#.###/#.#.#/#.#.#/#.#.#/#.###` |
| `p1/d12`  | 11          | exact | 11           | `.#..#/##.##/.#..#/.#..#/.#..#` |
| `p1/d13`  | 12          | exact | 12           | `#.###/#...#/#.###/#.#../#.###` |
| `p1/d14`  | 13          | exact | 13           | `#.###/#...#/#.###/#...#/#.###` |
| `p1/d15`  | 14          | exact | 14           | `#.#.#/#.#.#/#.###/#...#/#...#` |
| `p1/d16`  | 15          | exact | 15           | `#.###/#.#../#.###/#...#/#.###` |
| `p1/d17`  | 16          | exact | 16           | `#.###/#.#../#.###/#.#.#/#.###` |
| `p1/d18`  | 17          | exact | 17           | `#.###/#.#.#/#...#/#...#/#...#` |
| `p1/d19`  | 18          | exact | 18           | `#.###/#.#.#/#.###/#.#.#/#.###` |
| `p1/d20`  | 19          | exact | 19           | `#.###/#.#.#/#.###/#...#/#...#` |

The 10–19 rows use the confirmed masks exactly as approved.

### `docs/christmas-bingo-patterns.pdf`

| Reference | Source name    | Mode  | Catalog name   | Source mask                     |
| --------- | -------------- | ----- | -------------- | ------------------------------- |
| `p1/d01`  | Christmas Tree | exact | Christmas Tree | `..#../.###./#####/..#../..#..` |
| `p1/d02`  | Tinsel         | exact | Tinsel         | `#.#.#/#.#.#/#.#.#/#.#.#/#.#.#` |
| `p1/d03`  | Reindeer       | exact | Reindeer       | `#...#/##.##/.###./.#.#./.###.` |
| `p1/d04`  | Skis           | exact | Skis           | `#..../#####/...../#..../#####` |
| `p1/d05`  | Wreath         | exact | Wreath         | `.###./#####/##.##/#####/.###.` |
| `p1/d06`  | Cross          | exact | Cross          | `..#../#####/..#../..#../..#..` |
| `p1/d07`  | Bell           | exact | Bell           | `..#../.###./.###./#####/..#..` |
| `p1/d08`  | Snow Boot      | exact | Snow Boot      | `..###/..###/..###/#####/#####` |
| `p1/d09`  | Mittens        | exact | Mittens        | `..##./.#..#/.#..#/##..#/.####` |
| `p1/d10`  | Snow           | exact | Snow           | `#.#.#/.#.#./#.#.#/.#.#./#.#.#` |
| `p1/d11`  | Gift           | exact | Gift           | `#####/#.#.#/#####/#.#.#/#####` |
| `p1/d12`  | Snowmobile     | exact | Snowmobile     | `.#.../#..../#####/.#.#./#####` |

## Duplicate Masks

Identical masks do not imply identical pattern identity. These source pairs
remain separate category-specific catalog entries and later receive distinct
stable IDs:

| Entries                             | Shared mask                     |
| ----------------------------------- | ------------------------------- |
| Shape Outside Edge / Letter O       | `#####/#...#/#...#/#...#/#####` |
| Shape X / Letter X                  | `#...#/.#.#./..#../.#.#./#...#` |
| Shape Cross / Christmas Cross       | `..#../#####/..#../..#../..#..` |
| Shape Checkerboard / Christmas Snow | `#.#.#/.#.#./#.#.#/.#.#./#.#.#` |

Shape Plus is related to Cross but is not mask-identical. No source mask may be
deduplicated, renamed, or transformed merely because it resembles another
entry.

## Audit Totals

| Source PDF                     | Diagrams |  Exact | Flexible examples | Aliases |
| ------------------------------ | -------: | -----: | ----------------: | ------: |
| `shapes-bingo-patterns.pdf`    |       25 |     22 |                 2 |       1 |
| `letter-bingo-patterns.pdf`    |       25 |     25 |                 0 |       0 |
| `number-bingo-patterns.pdf`    |       20 |     20 |                 0 |       0 |
| `christmas-bingo-patterns.pdf` |       12 |     12 |                 0 |       0 |
| **Total**                      |   **82** | **79** |             **2** |   **1** |

The 82 diagrams map to 81 source-derived catalog entries: the two Two Lines
diagrams map to one flexible entry, Full House maps to Blackout, and all other
diagrams retain their own category-specific identity.
