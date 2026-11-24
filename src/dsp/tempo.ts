/**
 * Tempo and beat-phase estimation from an onset-strength envelope.
 * Pure functions: no audio API, fully testable on synthetic signals.
 */

export interface TempoCandidate {
  bpm: number;
  score: number;
}

export interface TempoEstimate {
  bpm: number;
  /** Normalised autocorrelation at the beat lag, 0..1. */
  confidence: number;
  /** The chosen tempo plus its half/double-time alternatives (90/180 ambiguity). */
  candidates: TempoCandidate[];
}

/** Mean-removed, unbiased autocorrelation normalised so ac[0] = 1. */
export function autocorr(x: Float32Array, maxLag: number): Float32Array {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  const ac = new Float32Array(maxLag + 1);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += (x[i] - mean) * (x[i] - mean);
  e0 /= n || 1;
  if (e0 <= 1e-20) return ac;
  ac[0] = 1;
  for (let l = 1; l <= maxLag && l < n; l++) {
    let s = 0;
    for (let i = l; i < n; i++) s += (x[i] - mean) * (x[i - l] - mean);
    ac[l] = s / (n - l) / e0;
  }
  return ac;
}

function at(a: Float32Array, pos: number): number {
  if (pos < 0 || pos >= a.length - 1) return 0;
  const i = Math.floor(pos);
  const f = pos - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/** Sub-sample position of a local maximum near `pos` (±radius samples). */
function refinePeak(a: Float32Array, pos: number, radius: number): { pos: number; value: number } | null {
  const lo = Math.max(1, Math.round(pos) - radius);
  const hi = Math.min(a.length - 2, Math.round(pos) + radius);
  let best = -1;
  let bestV = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (a[i] > bestV) {
      bestV = a[i];
      best = i;
    }
  }
  if (best < 1 || !(a[best] >= a[best - 1] && a[best] >= a[best + 1])) return null;
  const y0 = a[best - 1];
  const y1 = a[best];
  const y2 = a[best + 1];
  const d = y0 - 2 * y1 + y2;
  const shift = d < 0 ? (0.5 * (y0 - y2)) / d : 0;
  return { pos: best + shift, value: y1 - 0.25 * (y0 - y2) * shift };
}

/**
 * Estimate tempo inside the half-open octave [loBpm, hiBpm).
 * Restricting the search to one octave makes the half/double-time choice
 * explicit: the caller (or the user, via x2 / ÷2) decides the octave.
 */
export function estimateTempo(env: Float32Array, envRate: number, loBpm: number, hiBpm: number): TempoEstimate {
  const maxLag = Math.min(env.length - 2, Math.ceil(((envRate * 60) / loBpm) * 4) + 4);
  const none: TempoEstimate = { bpm: 0, confidence: 0, candidates: [] };
  if (maxLag < 8) return none;
  const ac = autocorr(env, maxLag);

  // Metrical template: beat, two beats, bar — plus the half-beat subdivision.
  // Afro-Cuban patterns (tresillo 3+3+2, clave, tumbao) are strongly periodic
  // at 1.5 beats, often more than at the beat itself; a 1.5-beat "pulse"
  // however has no periodic half (0.75 beat falls off the eighth-note grid),
  // which the subdivision term detects. See docs/EXPERIMENTS.md.
  const score = (bpm: number): number => {
    const l = (envRate * 60) / bpm;
    return at(ac, l) + 0.5 * at(ac, 2 * l) + 0.25 * at(ac, 4 * l) + 0.5 * at(ac, l / 2);
  };

  let bestBpm = 0;
  let bestS = -Infinity;
  for (let bpm = loBpm; bpm < hiBpm; bpm += 0.25) {
    const s = score(bpm);
    if (s > bestS) {
      bestS = s;
      bestBpm = bpm;
    }
  }
  if (bestS <= 0) return none;

  // Refine using the longest reliable multiple of the beat lag: one envelope
  // sample is a much smaller tempo step at 4 beats than at 1 beat.
  let bpm = bestBpm;
  for (const m of [1, 2, 4]) {
    const lag = ((envRate * 60) / bpm) * m;
    if (lag + 3 >= ac.length) break;
    const p = refinePeak(ac, lag, Math.max(2, Math.round(lag * 0.03)));
    if (p && p.value > 0.1) bpm = (envRate * 60 * m) / p.pos;
  }
  if (bpm < loBpm * 0.97 || bpm > hiBpm * 1.03) bpm = bestBpm;

  const lag = (envRate * 60) / bpm;
  const confidence = Math.max(0, Math.min(1, at(ac, lag)));
  return {
    bpm,
    confidence,
    candidates: [
      { bpm, score: score(bpm) },
      { bpm: bpm / 2, score: score(bpm / 2) },
      { bpm: bpm * 2, score: score(bpm * 2) },
      { bpm: (bpm * 2) / 3, score: score((bpm * 2) / 3) },
      { bpm: (bpm * 3) / 2, score: score((bpm * 3) / 2) },
    ],
  };
}

export interface BeatPhase {
  /** Envelope samples between the most recent beat and the end of the buffer. */
  offset: number;
  /** Contrast of the comb response, 0..1. */
  strength: number;
}

/**
 * Response of a decaying pulse comb whose most recent tooth is `offset`
 * envelope samples before the end of the buffer.
 */
export function combResponse(env: Float32Array, period: number, offset: number): number {
  const n = env.length;
  const decay = Math.exp(-1 / 24);
  let s = 0;
  let w = 1;
  for (let pos = n - 1 - offset; pos >= 1; pos -= period) {
    s += w * at(env, pos);
    w *= decay;
  }
  return s;
}

/** Find where beats fall by sliding a decaying pulse comb of the given period over the envelope. */
export function estimateBeatPhase(env: Float32Array, period: number): BeatPhase {
  const steps = Math.max(2, Math.ceil(period));
  const resp = new Float32Array(steps);
  let sum = 0;
  let best = 0;
  for (let o = 0; o < steps; o++) {
    const s = combResponse(env, period, o);
    resp[o] = s;
    sum += s;
    if (s > resp[best]) best = o;
  }
  const mean = sum / steps;
  const y1 = resp[best];
  const y0 = resp[(best - 1 + steps) % steps];
  const y2 = resp[(best + 1) % steps];
  const d = y0 - 2 * y1 + y2;
  const shift = d < 0 ? (0.5 * (y0 - y2)) / d : 0;
  let offset = best + shift;
  if (offset < 0) offset += period;
  return { offset, strength: y1 > 0 ? Math.max(0, (y1 - mean) / y1) : 0 };
}
