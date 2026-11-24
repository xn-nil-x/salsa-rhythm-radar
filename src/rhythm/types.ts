/**
 * Reference rhythm library model.
 *
 * Positions are given on a discrete grid (`grid` steps per cycle) but may be
 * fractional, so microtiming variants can be expressed without a finer grid.
 * Reference events are *references*, never measurements: they are always
 * rendered and exported with kind = 'reference'.
 */

export type ClaveDirection = '3-2' | '2-3';

export type InstrumentId =
  | 'clave'
  | 'conga'
  | 'bass'
  | 'campana'
  | 'bongo'
  | 'timbales'
  | 'guiro'
  | 'maracas'
  | 'piano';

export interface PatternEvent {
  /** Grid position, 0 <= step < grid. Fractional values allowed. */
  step: number;
  /** Stroke type, instrument specific (e.g. 'open', 'slap', 'heel', 'mouth'). */
  stroke: string;
  /** Relative intensity 0..1. */
  intensity: number;
  /** Duration in grid steps, if meaningful (bass, piano, güiro). */
  duration?: number;
  /** MIDI note for pitched instruments. */
  pitch?: number | number[];
}

export interface RhythmPattern {
  id: string;
  name: string;
  tradition: string;
  instrument: InstrumentId;
  /** Beats (counts) per cycle; the radar cycle is 8 counts = two 4/4 bars. */
  cycleBeats: number;
  meter: string;
  /** Grid steps per cycle (32 = sixteenth notes over 8 counts). */
  grid: number;
  /**
   * Clave alignment of the written events. Patterns that depend on clave are
   * rotated by half a cycle to obtain the opposite direction.
   */
  clave: ClaveDirection | null;
  events: PatternEvent[];
  variants?: string[];
  /** Where the pattern comes from and how sure we are. */
  source: string;
  /** 'established' = widely documented; 'simplified' / 'illustrative' = one of many. */
  status: 'established' | 'simplified' | 'illustrative';
  notes?: string;
}

export interface PhaseEvent {
  /** Cycle phase 0..1 (0 = count 1, top of the dial). */
  phase: number;
  /** Angular extent as a fraction of the cycle (0 = point event). */
  extent: number;
  intensity: number;
  stroke: string;
}
