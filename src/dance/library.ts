import raw from './dance-patterns.json';

/**
 * Dance reference schemes. Fields follow the Salsa Alphabet feature axes
 * (support / weight transfer / direction / rotation / rhythm / articulation)
 * so that future IMU-derived observations can use the same vocabulary.
 */
export type DanceEventType = 'step' | 'break' | 'tap' | 'pause' | 'turn' | 'vertical';

export interface DanceEvent {
  /** Count 1..cycleBeats, may be fractional (e.g. 3.5 for a syncopation). */
  count: number;
  type: DanceEventType;
  foot: 'L' | 'R' | null;
  direction: 'forward' | 'back' | 'side' | 'diagonal' | 'in-place';
  weight: 'full' | 'partial' | 'none';
  rotation?: { dir: 'L' | 'R'; degrees: number };
}

export interface DancePattern {
  id: string;
  name: string;
  tradition: string;
  cycleBeats: number;
  events: DanceEvent[];
  source: string;
  status: 'established' | 'simplified' | 'illustrative';
  notes?: string;
}

export const DANCE_PATTERNS: DancePattern[] = (raw as { patterns: DancePattern[] }).patterns;

export function getDancePattern(id: string): DancePattern | undefined {
  return DANCE_PATTERNS.find((p) => p.id === id);
}
