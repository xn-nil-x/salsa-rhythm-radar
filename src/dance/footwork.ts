/**
 * Leader footwork state at an arbitrary musical time (pure, testable).
 *
 * Feet live in a floor plane: x = sideways (lane offset), y = forward(-)/back(+),
 * in "step" units. A foot starts moving MOVE_BEATS before its count and lands
 * exactly on the count; the landing flashes and fades over FLASH_BEATS.
 */
import type { DanceEvent, DancePattern } from './library';

export interface FootPos {
  x: number;
  y: number;
}

export interface FootView {
  pos: FootPos;
  /** 0..1 flash intensity of the latest landing. */
  flash: number;
  flashType: DanceEvent['type'] | null;
  /** This foot carries the weight. */
  weight: boolean;
}

export interface FootworkState {
  L: FootView;
  R: FootView;
  /** Event at (or just before) the current time, including pauses. */
  current: DanceEvent | null;
  next: DanceEvent | null;
  /** Position inside the 8-count cycle, 0..8. */
  cyclePos: number;
  /** Flash of the latest non-pause event regardless of foot (patterns without feet). */
  anyFlash: number;
}

export const MOVE_BEATS = 0.35;
export const FLASH_BEATS = 0.5;
const CENTER: FootPos = { x: 0, y: 0 };

function target(ev: DanceEvent, prev: FootPos): FootPos {
  const side = ev.foot === 'L' ? -1 : 1;
  switch (ev.direction) {
    case 'forward':
      return { x: 0, y: -1 };
    case 'back':
      return { x: 0, y: 1 };
    case 'together':
      return CENTER;
    case 'side':
      return { x: 0.8 * side, y: 0 };
    case 'diagonal':
      return { x: 0.6 * side, y: -0.8 };
    default:
      return prev;
  }
}

interface Placed {
  t: number;
  ev: DanceEvent;
  before: FootPos;
  after: FootPos;
}

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const moved = (a: FootPos, b: FootPos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1e-6;

export function footworkAt(p: DancePattern, beats: number): FootworkState {
  const len = p.cycleBeats || 8;
  const c = Math.floor(beats / len);
  const timeline: Array<{ t: number; ev: DanceEvent }> = [];
  for (let k = c - 2; k <= c + 1; k++) for (const ev of p.events) timeline.push({ t: k * len + ev.count - 1, ev });
  timeline.sort((a, b) => a.t - b.t);

  const pos: Record<'L' | 'R', FootPos> = { L: CENTER, R: CENTER };
  const placed: Record<'L' | 'R', Placed[]> = { L: [], R: [] };
  let lastWeight: 'L' | 'R' | null = null;
  let current: DanceEvent | null = null;
  let next: DanceEvent | null = null;
  let lastAny = -Infinity;
  for (const { t, ev } of timeline) {
    if (t <= beats + 0.02) current = ev;
    else if (!next) next = ev;
    if (ev.type !== 'pause' && t <= beats) lastAny = t;
    if (!ev.foot || ev.type === 'pause') continue;
    const before = pos[ev.foot];
    const after = target(ev, before);
    placed[ev.foot].push({ t, ev, before, after });
    pos[ev.foot] = after;
    if (t <= beats && ev.weight !== 'none') lastWeight = ev.foot;
  }

  const view = (f: 'L' | 'R'): FootView => {
    const list = placed[f];
    let last: Placed | null = null;
    let nxt: Placed | null = null;
    for (const pl of list) {
      if (pl.t <= beats) last = pl;
      else if (!nxt) nxt = pl;
    }
    let at = last ? last.after : CENTER;
    if (nxt && nxt.t - beats < MOVE_BEATS && moved(nxt.before, nxt.after)) {
      const u = ease(1 - (nxt.t - beats) / MOVE_BEATS);
      at = { x: nxt.before.x + (nxt.after.x - nxt.before.x) * u, y: nxt.before.y + (nxt.after.y - nxt.before.y) * u };
    }
    const age = last ? beats - last.t : Infinity;
    return { pos: at, flash: age < 4 ? Math.exp(-age / FLASH_BEATS) : 0, flashType: last ? last.ev.type : null, weight: lastWeight === f };
  };

  const anyAge = beats - lastAny;
  return {
    L: view('L'),
    R: view('R'),
    current,
    next,
    cyclePos: ((beats % len) + len) % len,
    anyFlash: anyAge < 4 ? Math.exp(-anyAge / FLASH_BEATS) : 0,
  };
}
