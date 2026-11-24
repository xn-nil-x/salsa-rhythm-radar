import raw from './patterns.json';
import type { ClaveDirection, PhaseEvent, RhythmPattern } from './types';

export const PATTERNS: RhythmPattern[] = (raw as { patterns: RhythmPattern[] }).patterns;

export function getPattern(id: string): RhythmPattern | undefined {
  return PATTERNS.find((p) => p.id === id);
}

/** Validation errors for a pattern (empty = valid). Used by tests and the future editor. */
export function validatePattern(p: RhythmPattern): string[] {
  const errs: string[] = [];
  if (!p.id) errs.push('missing id');
  if (!(p.grid > 0)) errs.push('grid must be > 0');
  if (!(p.cycleBeats > 0)) errs.push('cycleBeats must be > 0');
  if (p.events.length === 0) errs.push('no events');
  let prev = -Infinity;
  for (const e of p.events) {
    if (!(e.step >= 0 && e.step < p.grid)) errs.push(`step ${e.step} outside [0, ${p.grid})`);
    if (!(e.intensity >= 0 && e.intensity <= 1)) errs.push(`intensity ${e.intensity} outside [0, 1]`);
    if (e.step <= prev) errs.push(`events not strictly increasing at step ${e.step}`);
    prev = e.step;
  }
  return errs;
}

/**
 * Events of a pattern as cycle phases for a given clave direction.
 * Clave-dependent patterns written in the other direction are rotated by half
 * a cycle (one bar), which is exactly how 3-2 and 2-3 relate.
 */
export function patternPhases(p: RhythmPattern, clave: ClaveDirection): PhaseEvent[] {
  const rotate = p.clave !== null && p.clave !== clave ? 0.5 : 0;
  return p.events
    .map((e) => ({
      phase: (e.step / p.grid + rotate) % 1,
      extent: (e.duration ?? 0) / p.grid,
      intensity: e.intensity,
      stroke: e.stroke,
    }))
    .sort((a, b) => a.phase - b.phase);
}

/** Clave pattern ids by family, used by the layer settings. */
export const CLAVE_FAMILIES = {
  son: { '3-2': 'son-clave-3-2', '2-3': 'son-clave-2-3' },
  rumba: { '3-2': 'rumba-clave-3-2', '2-3': 'rumba-clave-2-3' },
} as const;
export type ClaveFamily = keyof typeof CLAVE_FAMILIES;
