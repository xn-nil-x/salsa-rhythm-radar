/**
 * The "tape": a time-indexed history of observations that is re-folded onto
 * the musical cycle with the *current* clock whenever the display is rebuilt.
 *
 * Earlier versions accumulated directly into phase cells, so any change of
 * tempo or phase either smeared old data or forced a reset. Here the raw
 * history is kept; when the phase tracker changes tempo or phase (smoothly),
 * the whole accumulated image is rebuilt under the new mapping and therefore
 * stretches, shrinks or rotates with it instead of being erased.
 *
 * Ageing: an observation of age `a` weighs exp(-a / tau) with
 * tau = memoryCycles x cycleDuration, i.e. the same "N cycles" memory as before.
 */

export type AccumDisplay = 'power' | 'coherent' | 'coherence';

/** Ring buffer of complex spectra with their centre times. */
export class FrameHistory {
  readonly re: Float32Array;
  readonly im: Float32Array;
  readonly time: Float64Array;
  /** Beat number assigned by the clock at recording time (for 'recorded' tape mode). */
  readonly beats: Float64Array;
  private head = 0;
  private count = 0;

  constructor(
    readonly capacity: number,
    readonly bins: number,
  ) {
    this.re = new Float32Array(capacity * bins);
    this.im = new Float32Array(capacity * bins);
    this.time = new Float64Array(capacity);
    this.beats = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  push(t: number, re: ArrayLike<number>, im: ArrayLike<number>, beats = 0): number {
    const slot = this.head;
    const base = slot * this.bins;
    for (let k = 0; k < this.bins; k++) {
      this.re[base + k] = re[k];
      this.im[base + k] = im[k];
    }
    this.time[slot] = t;
    this.beats[slot] = beats;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return slot;
  }

  /** Slots from oldest to newest. */
  *slots(): Generator<number> {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) yield (start + i) % this.capacity;
  }
}

/**
 * Cycle phase (0..1) of an observation made at time t, which the clock of that
 * moment numbered `beats`. 'refold' mode ignores `beats` and re-maps t with the
 * current clock; 'recorded' mode uses `beats`.
 */
export type PhaseMap = (t: number, beats: number) => number;

export interface FoldParams {
  phaseOf: PhaseMap;
  /** Cycle duration, seconds (current clock). */
  cycleDur: number;
  /** Current time (newest data), seconds. */
  now: number;
  /** Memory in cycles; <= 1 means "latest cycle only". */
  memoryCycles: number;
  /** FFT size and sample rate, for the sub-frame phase compensation. */
  fftSize: number;
  sampleRate: number;
}

export function ageWeight(age: number, p: Pick<FoldParams, 'cycleDur' | 'memoryCycles'>): number {
  if (age < 0) return 1;
  if (p.memoryCycles <= 1) return age < p.cycleDur ? 1 : 0;
  return Math.exp(-age / (p.memoryCycles * p.cycleDur));
}

/** History needed for a given memory (older frames weigh < 0.2 %). */
export function historySeconds(p: Pick<FoldParams, 'cycleDur' | 'memoryCycles'>): number {
  return p.memoryCycles <= 1 ? p.cycleDur * 1.05 : p.memoryCycles * p.cycleDur * 6;
}

/**
 * Polar spectrogram folded from a FrameHistory.
 * Per cell: W (weight), P = Σw|X|², C = Σw·X·e^{+j2πkδ/N}.
 * Display: power P/W, coherent |C|²/W², coherence |C|²/(P·W) ∈ [0,1].
 */
export class FoldedSpectrogram {
  readonly P: Float32Array;
  readonly Cr: Float32Array;
  readonly Ci: Float32Array;
  readonly W: Float32Array;

  constructor(
    readonly angleBins: number,
    readonly freqBins: number,
  ) {
    this.P = new Float32Array(angleBins * freqBins);
    this.Cr = new Float32Array(angleBins * freqBins);
    this.Ci = new Float32Array(angleBins * freqBins);
    this.W = new Float32Array(angleBins);
  }

  clear(): void {
    this.P.fill(0);
    this.Cr.fill(0);
    this.Ci.fill(0);
    this.W.fill(0);
  }

  /** Refold the whole history under the current clock. */
  rebuild(h: FrameHistory, p: FoldParams): void {
    this.clear();
    for (const s of h.slots()) this.addSlot(h, s, p);
  }

  /** Add one history frame under the current clock. */
  addSlot(h: FrameHistory, slot: number, p: FoldParams): void {
    const t = h.time[slot];
    const w = ageWeight(p.now - t, p);
    if (w < 2e-3) return;
    const A = this.angleBins;
    const K = Math.min(this.freqBins, h.bins);
    const phi = p.phaseOf(t, h.beats[slot]);
    const x = phi * A;
    const a0 = Math.floor(x);
    const f = x - a0;
    const base = slot * h.bins;
    for (let side = 0; side < 2; side++) {
      const a = ((side === 0 ? a0 : a0 + 1) % A + A) % A;
      const wa = w * (side === 0 ? 1 - f : f);
      if (wa <= 0) continue;
      // Time from the frame centre to this cell's centre, in samples.
      let dPhase = (side === 0 ? a0 : a0 + 1) / A - phi;
      dPhase -= Math.round(dPhase);
      const delta = dPhase * p.cycleDur * p.sampleRate;
      // X_wanted[k] = X[k] e^{+j 2 pi k delta / N}
      const step = (2 * Math.PI * delta) / p.fftSize;
      const cs = Math.cos(step);
      const sn = Math.sin(step);
      let rr = 1;
      let ri = 0;
      const cb = a * this.freqBins;
      for (let k = 0; k < K; k++) {
        const xr = h.re[base + k];
        const xi = h.im[base + k];
        this.P[cb + k] += wa * (xr * xr + xi * xi);
        this.Cr[cb + k] += wa * (xr * rr - xi * ri);
        this.Ci[cb + k] += wa * (xr * ri + xi * rr);
        const nr = rr * cs - ri * sn;
        ri = rr * sn + ri * cs;
        rr = nr;
      }
      this.W[a] += wa;
    }
  }

  filled(): number {
    let n = 0;
    for (let a = 0; a < this.angleBins; a++) if (this.W[a] > 0) n++;
    return n;
  }

  maxPowerDb(): number {
    let m = 0;
    for (let a = 0; a < this.angleBins; a++) {
      const w = this.W[a];
      if (w <= 0) continue;
      const base = a * this.freqBins;
      for (let k = 0; k < this.freqBins; k++) {
        const v = this.P[base + k] / w;
        if (v > m) m = v;
      }
    }
    return m > 0 ? 10 * Math.log10(m) : -120;
  }

  /** Bytes for display: 0 = no data, 1..255 = value. */
  render(mode: AccumDisplay, dbRange: number, out: Uint8Array): void {
    const K = this.freqBins;
    const dbTop = this.maxPowerDb();
    for (let a = 0; a < this.angleBins; a++) {
      const base = a * K;
      const w = this.W[a];
      if (w <= 0) {
        out.fill(0, base, base + K);
        continue;
      }
      for (let k = 0; k < K; k++) {
        const i = base + k;
        const p = this.P[i] / w;
        const c = (this.Cr[i] * this.Cr[i] + this.Ci[i] * this.Ci[i]) / (w * w);
        let v: number;
        if (mode === 'coherence') {
          const db = 10 * Math.log10(p + 1e-20);
          v = p > 1e-20 && db > dbTop - dbRange ? Math.min(1, c / p) : 0;
        } else {
          const db = 10 * Math.log10((mode === 'power' ? p : c) + 1e-20);
          v = (db - (dbTop - dbRange)) / dbRange;
        }
        out[i] = 1 + Math.round(254 * (v < 0 ? 0 : v > 1 ? 1 : v));
      }
    }
  }
}

export interface OnsetRecord {
  time: number;
  /** Beat number assigned by the clock at detection time. */
  beats: number;
  channel: number;
  strength: number;
}

/**
 * Onset density folded with the current clock (no quantisation: each onset is
 * split linearly between its two neighbouring phase bins).
 */
export function foldOnsets(onsets: OnsetRecord[], channels: number, bins: number, p: Omit<FoldParams, 'fftSize' | 'sampleRate'>): Float32Array {
  const d = new Float32Array(channels * bins);
  for (const o of onsets) {
    const w = ageWeight(p.now - o.time, p);
    if (w < 2e-3) continue;
    const x = p.phaseOf(o.time, o.beats) * bins;
    const i = Math.floor(x);
    const f = x - i;
    const b0 = ((i % bins) + bins) % bins;
    const b1 = (b0 + 1) % bins;
    const s = w * Math.min(o.strength, 4);
    d[o.channel * bins + b0] += s * (1 - f);
    d[o.channel * bins + b1] += s * f;
  }
  return d;
}
