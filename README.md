# Sokoban Solver

[![Sokoban Solver](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/tranquilnaturevista-code/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/tranquilnaturevista-code/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the
[make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).
One program (`main.ts`, Node 22, standard library only) answers a whole
set of 5 levels, writing `/output/<id>/solution.txt` for each.

## How it works

Scoring counts **pushes**, not moves, and a level is worth its full 1,000
points only at the push-optimal count P\*. The generator builds every
level as a hallway with one to four small rooms off it (3–4 boxes each),
and a box pushed out of its room can never come back, so the rooms are
independent: P\* is the sum of the rooms' optima, and the level is solved
by solving each room on its own, in turn, walking the player between them
(walks cost moves, never pushes).

Each room is solved by A\* over **pushes**: a state is the boxes' squares
plus the player's reachable region (named by its lowest square, since the
player walks freely inside it). The estimate is the cheapest assignment
of boxes to goals by grid distance, a lower bound on the pushes left (one
push moves one box one square), so the first solved state A\* pops is
push-optimal. Two prunings keep the search small: a box on a dead square
(one no push can ever bring to a goal) and a frozen 2×2 block of walls
and boxes holding a box off its goal. The budget is a fixed number of
states, never the clock, so two runs write the same bytes; if A\* ever
gives up on a room it falls back to plain breadth-first over pushes.

## Results

Practice set (kit's `practice/`, scored with the kit's scorer):

| instance | boxes | pushes | P\* | points |
|----------|-------|--------|-----|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

**Score 1,000,000 / 1,000,000** — every instance at exactly P\*.
The house baseline (plain-astar 1.0.0) scores 200,000 on the same set
(it solves only i001 and gives up on the rest).

The solver was also run on three further sets drawn from the kit's
generator with fresh seeds: all three scored 1,000,000 as well (every
instance at P\*). Whole-set runtime is about 0.3 seconds, far inside
the 60-second wall budget, and two runs write byte-identical output.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` (XSB: `#` wall, space floor,
`.` goal, `$` box, `*` box on a goal, `@` player) and writes
`/output/<id>/solution.txt` (moves in LURD, an upper-case letter
marking a push).
