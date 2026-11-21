// A push-optimal Sokoban solver.
//
// Why this shape
// --------------
// Scoring counts PUSHES, not moves, and a level is worth its full 1,000
// points only at the push-optimal count P*. The generator builds every
// level as a hallway with one to four small rooms off it (3-4 boxes each),
// and a box pushed out of its room can never come back, so the rooms are
// independent: P* is the sum of the rooms' optima, and the level is solved
// by solving each room on its own, in turn, walking the player between
// them (walks cost moves, never pushes).
//
// Each room is solved by A* over PUSHES: a state is the boxes' squares
// plus the player's reachable region (named by its lowest square, since
// the player walks freely inside it). The estimate is the cheapest
// assignment of boxes to goals by grid distance, a lower bound on the
// pushes left (one push moves one box one square), so the first solved
// state A* pops is push-optimal. Two prunings keep the search small: a
// box on a dead square (one no push can ever bring to a goal) and a frozen
// 2x2 block of walls and boxes holding a box off its goal. The budget is
// a fixed number of states, never the clock, so two runs write the same
// bytes.
//
// The entrypoint reads /input/<id>/level.txt and writes
// /output/<id>/solution.txt (moves in LURD, upper case marking a push).
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input
// MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up (work, never the clock). */
const MAX_STATES = 250_000;

/** Directions: [dx, dy, step letter, push letter], up/down/left/right. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  let qi = 0;
  for (const g of goals) live[g] = 1;
  while (qi < queue.length) {
    const x = queue[qi++]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` (a box mask) in the way; returns the lowest. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Grid distances from `from` over open floor (walls only), -1 where unreachable. */
function bfsDist(wall: Uint8Array, w: number, from: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || dist[q] !== -1) continue;
      dist[q] = dist[p]! + 1;
      queue.push(q);
    }
  }
  return dist;
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

/**
 * The cheapest assignment of boxes to goals by grid distance (subset DP).
 * A lower bound on the pushes left: one push moves one box one square, so
 * the matching cost can change by at most 1 per push, which makes it a
 * consistent estimate for A*. Zero when every box sits on a goal.
 */
function estimate(boxes: number[], dist: Int32Array[]): number {
  const m = boxes.length;
  const dp = new Array<number>(1 << m).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < (1 << m); mask++) {
    const k = popcount(mask);
    if (k >= m || dp[mask] === Infinity) continue;
    for (let g = 0; g < m; g++) {
      if (mask & (1 << g)) continue;
      const d = dist[g]![boxes[k]!];
      const v = dp[mask]! + (d < 0 ? 1_000_000 : d);
      const nm = mask | (1 << g);
      if (v < dp[nm]!) dp[nm] = v;
    }
  }
  return dp[(1 << m) - 1]!;
}

/** A binary heap on [f, g, state]: lower f first, deeper (higher g) first on a tie, earlier state first after that. */
class Heap {
  private a: [number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(f: number, g: number, i: number): void {
    const a = this.a;
    let n = a.length;
    a.push([f, g, i]);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (!less(a[n]!, a[p]!)) break;
      const t = a[n]!;
      a[n] = a[p]!;
      a[p] = t;
      n = p;
    }
  }
  pop(): [number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let n = 0;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1]!, a[c]!)) c++;
        if (!less(a[c]!, a[n]!)) break;
        const t = a[n]!;
        a[n] = a[c]!;
        a[c] = t;
        n = c;
      }
    }
    return top;
  }
}

function less(x: [number, number, number], y: [number, number, number]): boolean {
  return x[0] < y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])));
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: (string | undefined)[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level`, at most `maxStates` states:
 * {pushes, moves} (moves in LURD, a lower letter a step, an upper one a
 * push), or null when the search gives up (or the level has no solution).
 * With `heuristic` the search is A* on the matching estimate (optimal);
 * without it, it is plain breadth-first over pushes (also optimal, slower).
 * A solved state is answered when it is popped, never when it is made, so
 * the first one popped holds the fewest pushes.
 */
function solvePushOptimal(level: Level, maxStates: number, heuristic: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const dist = goals.map((g) => bfsDist(wall, w, g));

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states, in creation order: their boxes, the player's square, the
  // pushes so far, the parent and the push that made them, and their key.
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sKey: number[] = [];
  for (const b of level.boxes) occupied[b] = 1;
  sKey.push(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack)));
  for (const b of level.boxes) occupied[b] = 0;

  const best = new Map<number, number>([[sKey[0]!, 0]]);
  const heap = new Heap();
  heap.push(heuristic ? estimate(level.boxes, dist) : 0, 0, 0);

  let found = -1;
  while (heap.size > 0) {
    const [, g, s] = heap.pop();
    if (best.get(sKey[s]!) !== g) continue; // a better route to this state exists
    const boxes = sBoxes[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d]!;
        const dd = dy * w + dx;
        const t = b + dd;
        if (seen[b - dd] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const ng = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, ng);
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(ng);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sKey.push(key);
        heap.push(ng + (heuristic ? estimate(next, dist) : 0), ng, sBoxes.length - 1);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const x of boxes) occupied[x] = 0;
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes[boxes.indexOf(from)] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room, its squares, boxes and goals. Null when
 * some part holds more or fewer boxes than goals, or a box starts in the
 * hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room, so the rooms' optima add up to
 * the level's. Falls back to the whole level when the level is no set of
 * rooms, and to plain breadth-first when A* gives up on a room.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_STATES, true) ?? solvePushOptimal(level, MAX_STATES, false);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePushOptimal(sub, MAX_STATES, true);
    if (solved === null) solved = solvePushOptimal(sub, MAX_STATES, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
const solve = (text: string): string => {
  const solved = solveByRooms(parseLevel(text));
  return solved === null ? '' : solved.moves;
};

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
