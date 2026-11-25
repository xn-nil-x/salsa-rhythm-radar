/**
 * Epoch folding ("rolling the tape into a tube").
 *
 * The onset envelope is folded onto itself with a trial period C — the
 * duration of one whole 8-count cycle, not one beat. If C is right, the
 * attacks of every cycle land in the same phase cells and the folded profile
 * is sharp; if C is wrong, successive cycles drift and the profile smears.
 *
 * Sharpness is the weighted epoch-folding chi-square (Leahy et al. 1983),
 * normalised by its expectation for an aperiodic signal, so 1 ≈ "like noise"
 * and e.g. 20 ≈ "the rhythm is 20x clearer than noise".
 *
 * Folding at the whole cycle uses the full rhythmic pattern: a wrong period
 * such as 1.5 beats (tresillo) or 12 beats smears the 2-bar clave pattern,
 * which plain beat-level autocorrelation cannot see. Mathematically, the
 * folding statistic equals a weighted sum of the autocorrelation at all
 * multiples of C — a windowed autocorrelation evaluated on a comb of lags.
 */

export interface FoldOptions {
  /** Phase bins per cycle (64 = 32nd notes on an 8-count cycle). */
  bins: number;
  /** Exponential memory of the envelope, seconds. */
  tau: number;
}

export const DEFAULT_FOLD: FoldOptions = { bins: 64, tau: 8 };

export interface Fold {
  period: number;
  /** Weighted mean envelope per phase bin. */
  profile: Float32Array;
  /** Normalised sharpness: ≈1 for noise, larger = clearer periodicity. */
  sharpness: number;
}

/**
 * Fold `env` (sampled at `rate`, last sample at time `tEnd`) at period C.
 * Bin b covers cycle phase [b/B, (b+1)/B) of absolute time t / C; each sample
 * is split linearly between neighbouring bins so the statistic is smooth in C.
 */
export function fold(env: ArrayLike<number>, rate: number, tEnd: number, C: number, opt: FoldOptions = DEFAULT_FOLD): Fold {
  const B = opt.bins;
  const n = env.length;
  const sum = new Float64Array(B);
  const wsum = new Float64Array(B);
  const w2sum = new Float64Array(B);
  let sw = 0;
  let swx = 0;
  let swxx = 0;
  const dt = 1 / rate;
  for (let i = 0; i < n; i++) {
    const age = (n - 1 - i) * dt;
    const w = Math.exp(-age / opt.tau);
    if (w < 1e-3) continue;
    const x = env[i];
    const t = tEnd - age;
    let pos = (t / C) * B;
    pos -= Math.floor(pos / B) * B;
    const b0 = Math.floor(pos);
    const f = pos - b0;
    const b1 = b0 + 1 === B ? 0 : b0 + 1;
    const w0 = w * (1 - f);
    const w1 = w * f;
    sum[b0] += w0 * x;
    wsum[b0] += w0;
    w2sum[b0] += w0 * w0;
    sum[b1] += w1 * x;
    wsum[b1] += w1;
    w2sum[b1] += w1 * w1;
    sw += w;
    swx += w * x;
    swxx += w * x * x;
  }
  const profile = new Float32Array(B);
  if (sw <= 0) return { period: C, profile, sharpness: 0 };
  const mu = swx / sw;
  const varx = Math.max(1e-20, swxx / sw - mu * mu);
  let S = 0;
  let E0 = 0;
  for (let b = 0; b < B; b++) {
    if (wsum[b] <= 0) continue;
    const p = sum[b] / wsum[b];
    profile[b] = p;
    S += (wsum[b] * (p - mu) * (p - mu)) / varx;
    // Expected contribution under the null: var(p_b) = varx * Σw² / (Σw)².
    E0 += w2sum[b] / wsum[b];
  }
  return { period: C, profile, sharpness: E0 > 0 ? S / E0 : 0 };
}

/** Metrical levels of an 8-count cycle: cycle, bar, half-bar, beat, eighth. */
export const LEVELS = [1, 2, 4, 8, 16] as const;

/**
 * Hierarchical folding score: the true 8-count period folds sharply at every
 * metrical level (cycle, bar, 2 beats, beat, eighth). A wrong period that
 * happens to be a multiple of a 1-bar pattern (e.g. 3 bars) folds well at the
 * top level but its "beat" (1.5 true beats) and "eighth" (0.75 beats) fall off
 * the grid. Combination = geometric mean of the per-level sharpness.
 */
export function metricalScore(env: ArrayLike<number>, rate: number, tEnd: number, C: number, opt: FoldOptions = DEFAULT_FOLD): number {
  let logSum = 0;
  for (const m of LEVELS) {
    const bins = Math.max(12, Math.round(opt.bins / m));
    const s = fold(env, rate, tEnd, C / m, { bins, tau: opt.tau }).sharpness;
    logSum += Math.log(Math.max(1e-6, s));
  }
  return Math.exp(logSum / LEVELS.length);
}

export type Scorer = 'plain' | 'metrical';

export interface CycleCandidate {
  /** Cycle period, seconds (8 counts). */
  period: number;
  /** Equivalent tempo in BPM (8 beats per cycle). */
  bpm: number;
  sharpness: number;
}

export interface CycleSearch {
  best: CycleCandidate | null;
  /** Distinct local maxima, strongest first. */
  candidates: CycleCandidate[];
  /** Median sharpness over the searched range: the "noise floor" of the periodogram. */
  floor: number;
  /** best.sharpness / floor — how much the best period stands out (≥1). */
  contrast: number;
  /** Best sharpness relative to the strongest *different* hypothesis (≥1; 1 = tie). */
  margin: number;
}

/**
 * Scan cycle periods in [Cmin, Cmax] on a geometric grid (relative step
 * `step`), then refine the peaks by parabolic interpolation in log-period.
 */
export function searchCycle(
  env: ArrayLike<number>,
  rate: number,
  tEnd: number,
  Cmin: number,
  Cmax: number,
  opt: FoldOptions = DEFAULT_FOLD,
  step = 0.002,
  scorer: Scorer = 'metrical',
): CycleSearch {
  const grid: number[] = [];
  const S: number[] = [];
  for (let C = Cmin; C <= Cmax * (1 + 1e-9); C *= 1 + step) {
    grid.push(C);
    S.push(scorer === 'metrical' ? metricalScore(env, rate, tEnd, C, opt) : fold(env, rate, tEnd, C, opt).sharpness);
  }
  const none: CycleSearch = { best: null, candidates: [], floor: 0, contrast: 0, margin: 0 };
  if (grid.length < 3) return none;
  const sorted = [...S].sort((a, b) => a - b);
  const floor = sorted[sorted.length >> 1] || 1e-9;

  const peaks: CycleCandidate[] = [];
  for (let j = 1; j < grid.length - 1; j++) {
    if (!(S[j] >= S[j - 1] && S[j] > S[j + 1])) continue;
    const d = S[j - 1] - 2 * S[j] + S[j + 1];
    const shift = d < 0 ? (0.5 * (S[j - 1] - S[j + 1])) / d : 0;
    const period = grid[j] * Math.pow(1 + step, shift);
    peaks.push({ period, bpm: (8 * 60) / period, sharpness: S[j] - 0.25 * (S[j - 1] - S[j + 1]) * shift });
  }
  // Edge maxima count too (the true period may sit at a range boundary).
  if (S[0] > S[1]) peaks.push({ period: grid[0], bpm: (8 * 60) / grid[0], sharpness: S[0] });
  const L = grid.length - 1;
  if (S[L] > S[L - 1]) peaks.push({ period: grid[L], bpm: (8 * 60) / grid[L], sharpness: S[L] });
  peaks.sort((a, b) => b.sharpness - a.sharpness);

  // Keep peaks that are distinct hypotheses (> 3% apart).
  const distinct: CycleCandidate[] = [];
  for (const p of peaks) {
    if (distinct.every((q) => Math.abs(p.period / q.period - 1) > 0.03)) distinct.push(p);
    if (distinct.length >= 6) break;
  }
  const best = distinct[0] ?? null;
  return {
    best,
    candidates: distinct,
    floor,
    contrast: best ? best.sharpness / floor : 0,
    margin: best && distinct[1] ? best.sharpness / Math.max(1e-9, distinct[1].sharpness) : best ? Infinity : 0,
  };
}

/**
 * Z²ₙ statistic of event times at trial period C (Buccheri et al. 1983, used in
 * pulsar timing): Σ_k |Σ_i w_i e^{j 2π k t_i / C}|², k = 1..n. Unlike folding a
 * sampled envelope into bins, it is smooth in C and uses the sub-hop precision of
 * the onset times, so its peak gives an unbiased, precise period.
 */
export function z2(times: ArrayLike<number>, weights: ArrayLike<number>, C: number, harmonics: number): number {
  let total = 0;
  for (let k = 1; k <= harmonics; k++) {
    let re = 0;
    let im = 0;
    const w0 = (2 * Math.PI * k) / C;
    for (let i = 0; i < times.length; i++) {
      const a = w0 * times[i];
      re += weights[i] * Math.cos(a);
      im += weights[i] * Math.sin(a);
    }
    total += re * re + im * im;
  }
  return total;
}

/** Refine a cycle period by maximising Z²ₙ of onset times within ±span (relative). */
export function refinePeriodByOnsets(times: ArrayLike<number>, weights: ArrayLike<number>, C0: number, span = 0.006, step = 0.0002, harmonics = 16): number | null {
  if (times.length < 8) return null;
  const grid: number[] = [];
  const S: number[] = [];
  for (let r = -span; r <= span + 1e-12; r += step) {
    const C = C0 * (1 + r);
    grid.push(C);
    S.push(z2(times, weights, C, harmonics));
  }
  let b = 1;
  for (let j = 1; j < S.length - 1; j++) if (S[j] > S[b]) b = j;
  if (!(S[b] >= S[b - 1] && S[b] >= S[b + 1])) return null; // peak at the edge: not trustworthy
  const d = S[b - 1] - 2 * S[b] + S[b + 1];
  const shift = d < 0 ? (0.5 * (S[b - 1] - S[b + 1])) / d : 0;
  return C0 * (1 - span + (b + shift) * step);
}

export interface BeatGrid {
  /** Cycle phase (0..1/8) of the first beat inside the folded cycle. */
  offset: number;
  /** Comb response at the chosen offset relative to the half-beat-shifted grid (≥1 = on-beat wins). */
  onOffRatio: number;
}

/**
 * Where the 8 beats sit inside the folded profile: an 8-tooth circular comb
 * slid over one beat, with sub-bin parabolic refinement.
 */
export function beatGrid(profile: Float32Array): BeatGrid {
  const B = profile.length;
  const per = B / 8;
  const at = (pos: number) => {
    let x = pos % B;
    if (x < 0) x += B;
    const i = Math.floor(x);
    const f = x - i;
    return profile[i] * (1 - f) + profile[(i + 1) % B] * f;
  };
  const comb = (o: number) => {
    let s = 0;
    for (let k = 0; k < 8; k++) s += at(o + k * per);
    return s;
  };
  const steps = Math.max(8, Math.round(per * 4));
  let best = 0;
  let bestV = -Infinity;
  const vals: number[] = [];
  for (let s = 0; s < steps; s++) {
    const v = comb((s / steps) * per);
    vals.push(v);
    if (v > bestV) {
      bestV = v;
      best = s;
    }
  }
  const y0 = vals[(best - 1 + steps) % steps];
  const y2 = vals[(best + 1) % steps];
  const d = y0 - 2 * bestV + y2;
  const shift = d < 0 ? (0.5 * (y0 - y2)) / d : 0;
  let o = ((best + shift) / steps) * per;
  o = ((o % per) + per) % per;
  const off = comb(o + per / 2);
  return { offset: o / B, onOffRatio: off > 0 ? comb(o) / off : Infinity };
}
