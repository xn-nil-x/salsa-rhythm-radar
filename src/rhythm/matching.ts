/**
 * Cyclic correlation between a reference pattern and an observed onset
 * density (MVP 3 seam). The result is a *statistic of agreement*, not an
 * instrument identification: a band density can match the clave because the
 * clave plays there, or because something else shares its timing.
 */
import type { PhaseEvent } from './types';

export interface MatchResult {
  /** Pearson correlation at zero lag (pattern exactly where the clock says). */
  r0: number;
  /** Best correlation over all cyclic lags, and that lag as a cycle fraction (-0.5..0.5). */
  rBest: number;
  lagBest: number;
}

/** Pattern events blurred onto `bins` circular bins (Gaussian, sigma in bins). */
export function patternProfile(events: PhaseEvent[], bins: number, sigma = 1.2): Float32Array {
  const out = new Float32Array(bins);
  const R = Math.ceil(sigma * 3);
  for (const e of events) {
    const c = e.phase * bins;
    const i0 = Math.floor(c);
    for (let d = -R; d <= R + 1; d++) {
      const i = i0 + d;
      const x = i - c;
      out[((i % bins) + bins) % bins] += e.intensity * Math.exp((-x * x) / (2 * sigma * sigma));
    }
  }
  return out;
}

function pearsonShift(a: Float32Array, b: ArrayLike<number>, shift: number): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[(i + shift) % n] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export function matchPattern(events: PhaseEvent[], density: ArrayLike<number>): MatchResult {
  const n = density.length;
  const prof = patternProfile(events, n);
  let best = -Infinity;
  let bestShift = 0;
  for (let s = 0; s < n; s++) {
    const r = pearsonShift(prof, density, s);
    if (r > best) {
      best = r;
      bestShift = s;
    }
  }
  let lag = bestShift / n;
  if (lag >= 0.5) lag -= 1;
  return { r0: pearsonShift(prof, density, 0), rBest: best, lagBest: lag };
}
