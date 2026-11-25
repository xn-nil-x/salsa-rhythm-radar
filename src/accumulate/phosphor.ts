/**
 * "Phosphor" polar spectrogram: a CRT-like screen with exponential persistence.
 *
 * Every cell keeps only its current value. When the sweep (the current cycle
 * phase) passes over a cell, the new observation x pulls it by 1/N of the
 * difference:   v <- v + (x - v) / N,   N = memory in cycles.
 * Nothing else is stored, there is no history to refold, and an instrument
 * that stopped playing fades by (1 - 1/N) per cycle *in display brightness*,
 * i.e. after ~3N cycles it is gone (95 %), whatever the dB range.
 *
 * Why brightness and not power: the tape (folded.ts) averages power with
 * exponential weights and shows it in dB. A bass 40 dB above the claves at the
 * same frequency, weighted down to 5 %, is still 27 dB above them, so on a 60 dB
 * scale its trace stays visible for ~N·ln(10)·range/10 cycles (≈ 220 cycles for
 * N = 16). The phosphor decays the dB-mapped brightness itself.
 *
 * Cells are stored in "recorded" phase coordinates (the beat numbering at the
 * moment of writing); a display rotation maps them to the current clock, so
 * moving count 1 rotates the image instead of corrupting it. Tempo changes are
 * not refolded: like a real screen, what was drawn stays where it was drawn.
 *
 * Coherent displays use complex and power averages with the same update rule:
 * coherence rho = |C|^2 / (P W) in [0, 1]; "coherent" brightness = L * rho.
 */

import type { AccumDisplay } from './folded';

export interface PhosphorWrite {
  /** Recorded-coordinate cycle phase of the frame centre, 0..1. */
  phase: number;
  /** Cycle duration, seconds. */
  cycleDur: number;
  /** Seconds between frames. */
  frameStep: number;
  /** Memory in cycles (1 = only the latest sweep). */
  memoryCycles: number;
  dbRange: number;
  fftSize: number;
  sampleRate: number;
}

export class PhosphorScreen {
  /** Brightness 0..1 (power display), per cell. */
  readonly L: Float32Array;
  readonly P: Float32Array;
  readonly Cr: Float32Array;
  readonly Ci: Float32Array;
  /** Weight per cell: tends to 1 as observations accumulate (bias correction). */
  readonly W: Float32Array;
  /** Running peak of frame power, dB: top of the brightness scale. */
  peakDb = -Infinity;
  private readonly x: Float32Array;

  constructor(
    readonly angleBins: number,
    readonly freqBins: number,
  ) {
    const n = angleBins * freqBins;
    this.L = new Float32Array(n);
    this.P = new Float32Array(n);
    this.Cr = new Float32Array(n);
    this.Ci = new Float32Array(n);
    this.W = new Float32Array(n);
    this.x = new Float32Array(freqBins);
  }

  clear(): void {
    this.L.fill(0);
    this.P.fill(0);
    this.Cr.fill(0);
    this.Ci.fill(0);
    this.W.fill(0);
    this.peakDb = -Infinity;
  }

  /**
   * Write one spectrum frame (re/im, first freqBins bins) at `p.phase`.
   * `re === null` = silence: brightness decays, the averages are left alone.
   */
  write(re: ArrayLike<number> | null, im: ArrayLike<number> | null, p: PhosphorWrite): void {
    const A = this.angleBins;
    const K = this.freqBins;
    const x = this.x;
    if (re && im) {
      let maxP = 0;
      for (let k = 0; k < K; k++) {
        const pw = re[k] * re[k] + im[k] * im[k];
        x[k] = pw;
        if (pw > maxP) maxP = pw;
      }
      // The scale top follows the loudest frames and sinks 1 dB/s in quieter passages.
      const frameDb = 10 * Math.log10(maxP + 1e-20);
      this.peakDb = Math.max(frameDb, this.peakDb - p.frameStep);
      const lo = this.peakDb - p.dbRange;
      for (let k = 0; k < K; k++) {
        const v = (10 * Math.log10(x[k] + 1e-20) - lo) / p.dbRange;
        x[k] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    } else {
      x.fill(0);
    }

    // A cell is crossed by ~cycleDur / (frameStep * A) frames per sweep; scale the
    // per-frame step so the whole sweep moves the cell by exactly 1/N.
    const framesPerCell = p.cycleDur / (p.frameStep * A);
    const keep = 1 - 1 / Math.max(1, p.memoryCycles);
    const pos = p.phase * A;
    const a0 = Math.floor(pos);
    const f = pos - a0;
    for (let side = 0; side < 2; side++) {
      const share = side === 0 ? 1 - f : f;
      if (share <= 0) continue;
      const ai = side === 0 ? a0 : a0 + 1;
      const a = ((ai % A) + A) % A;
      const alpha = keep <= 0 ? 1 : 1 - Math.pow(keep, share / framesPerCell);
      const cb = a * K;
      for (let k = 0; k < K; k++) this.L[cb + k] += alpha * (x[k] - this.L[cb + k]);
      if (!re || !im) continue;
      // Align the frame to the cell centre (sub-frame time shift = linear phase ramp).
      let dPhase = ai / A - p.phase;
      dPhase -= Math.round(dPhase);
      const step = (2 * Math.PI * dPhase * p.cycleDur * p.sampleRate) / p.fftSize;
      const cs = Math.cos(step);
      const sn = Math.sin(step);
      let rr = 1;
      let ri = 0;
      for (let k = 0; k < K; k++) {
        const i = cb + k;
        const xr = re[k];
        const xi = im[k];
        this.P[i] += alpha * (xr * xr + xi * xi - this.P[i]);
        this.Cr[i] += alpha * (xr * rr - xi * ri - this.Cr[i]);
        this.Ci[i] += alpha * (xr * ri + xi * rr - this.Ci[i]);
        this.W[i] += alpha * (1 - this.W[i]);
        const nr = rr * cs - ri * sn;
        ri = rr * sn + ri * cs;
        rr = nr;
      }
    }
  }

  /**
   * Bytes for display (0 = never written, 1..255 = value), rotated by `rotation`
   * of a cycle (recorded coordinates -> current clock).
   */
  render(mode: AccumDisplay, rotation: number, out: Uint8Array): void {
    const A = this.angleBins;
    const K = this.freqBins;
    const s = ((Math.round(rotation * A) % A) + A) % A;
    for (let d = 0; d < A; d++) {
      const src = (d - s + A) % A;
      const sb = src * K;
      const db = d * K;
      for (let k = 0; k < K; k++) {
        const i = sb + k;
        const w = this.W[i];
        const l = this.L[i];
        if (w <= 0 && l <= 0) {
          out[db + k] = 0;
          continue;
        }
        let v = l;
        if (mode !== 'power') {
          const pw = this.P[i] * w;
          const rho = pw > 1e-30 ? Math.min(1, (this.Cr[i] * this.Cr[i] + this.Ci[i] * this.Ci[i]) / pw) : 0;
          v = mode === 'coherence' ? (l > 0.01 ? rho : 0) : l * rho;
        }
        out[db + k] = 1 + Math.round(254 * (v < 0 ? 0 : v > 1 ? 1 : v));
      }
    }
  }
}
