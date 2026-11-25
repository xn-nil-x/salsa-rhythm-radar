import { clamp } from '../util/math';

/**
 * Musical clock: maps audio time (seconds, AudioContext clock) to beats.
 *
 * `beatsAt` is the raw beat counter steered by the phase tracker (PLL).
 * `cycleBeatsAt` adds the user offset that decides which beat is count 1,
 * so manual corrections never fight with automatic tracking.
 */
export class Transport {
  tRef = 0;
  beatRef = 0;
  bpm = 180;
  /** User offset in beats (set count 1, nudge). */
  offset = 0;
  /** Max phase slew, beats per second: corrections are bled in, never jumped. */
  slewRate = 1.0;
  private pending = 0;

  beatsAt(t: number): number {
    return this.beatRef + ((t - this.tRef) * this.bpm) / 60;
  }

  cycleBeatsAt(t: number): number {
    return this.beatsAt(t) + this.offset;
  }

  timeAtCycleBeats(b: number): number {
    return this.tRef + ((b - this.offset - this.beatRef) * 60) / this.bpm;
  }

  /** Change tempo keeping phase continuous at time t. */
  setBpm(bpm: number, t: number): void {
    this.beatRef = this.beatsAt(t);
    this.tRef = t;
    this.bpm = clamp(bpm, 20, 480);
  }

  anchor(tRef: number, beatRef: number, bpm: number): void {
    this.tRef = tRef;
    this.beatRef = beatRef;
    this.bpm = clamp(bpm, 20, 480);
    this.pending = 0;
    this.bpmTarget = null;
  }

  /** Replace the outstanding phase correction (beats); applied gradually by `advance`. */
  setCorrection(beats: number): void {
    this.pending = beats;
  }

  get pendingCorrection(): number {
    return this.pending;
  }

  /** Tempo the clock glides to (null = none). */
  bpmTarget: number | null = null;
  /** Max relative tempo change per second while gliding (0.25 = 25 %/s). */
  bpmGlide = 0.25;
  /** Count-1 offset the clock glides to (null = none). */
  offsetTarget: number | null = null;
  /** Max offset change, beats per second. */
  offsetGlide = 6;

  /** Change tempo smoothly (phase stays continuous, no jumps). */
  glideBpm(target: number): void {
    this.bpmTarget = clamp(target, 20, 480);
  }

  /** Rotate count 1 smoothly to a new offset (beats). */
  glideOffset(target: number): void {
    this.offsetTarget = target;
  }

  /** Bleed a slice of the pending correction and glides; call once per analysis hop. */
  advance(t: number, dt: number): void {
    if (this.pending !== 0) {
      const max = this.slewRate * dt;
      const step = clamp(this.pending, -max, max);
      this.beatRef = this.beatsAt(t) + step;
      this.tRef = t;
      this.pending -= step;
      if (Math.abs(this.pending) < 1e-6) this.pending = 0;
    }
    if (this.bpmTarget !== null) {
      const max = this.bpm * this.bpmGlide * dt;
      const d = this.bpmTarget - this.bpm;
      if (Math.abs(d) <= max) {
        this.setBpm(this.bpmTarget, t);
        this.bpmTarget = null;
      } else this.setBpm(this.bpm + Math.sign(d) * max, t);
    }
    if (this.offsetTarget !== null) {
      const max = this.offsetGlide * dt;
      const d = this.offsetTarget - this.offset;
      if (Math.abs(d) <= max) {
        this.offset = this.offsetTarget;
        this.offsetTarget = null;
      } else this.offset += Math.sign(d) * max;
    }
  }
}
