/**
 * Polar spectrogram accumulator.
 *
 * The grid is indexed by [angle bin = musical phase inside the 8-count cycle]
 * x [FFT bin = frequency]. Every revolution revisits each angle bin once and
 * blends the new frame into what earlier cycles left there, with exponential
 * ageing. Two accumulators are fed by the same frames:
 *
 *  - power     (incoherent, phase-synchronous average of |X|^2) — robust for
 *              percussion, whose waveform phase is not repeatable;
 *  - coherent  (complex average of X) — keeps only what repeats with the same
 *              waveform phase from cycle to cycle; unstable components cancel.
 *
 * |coherent|^2 / power is the cycle-to-cycle coherence, 0..1.
 */

export type AccumDisplay = 'power' | 'coherent' | 'coherence';

/** dB range mapped onto byte values 1..255 (0 = never observed). */
export const DB_FLOOR = -110;

export class PolarSpectrogram {
  readonly power: Float32Array;
  readonly cre: Float32Array;
  readonly cim: Float32Array;
  private readonly seen: Uint8Array;

  constructor(
    readonly angleBins: number,
    readonly freqBins: number,
  ) {
    this.power = new Float32Array(angleBins * freqBins);
    this.cre = new Float32Array(angleBins * freqBins);
    this.cim = new Float32Array(angleBins * freqBins);
    this.seen = new Uint8Array(angleBins);
  }

  reset(): void {
    this.power.fill(0);
    this.cre.fill(0);
    this.cim.fill(0);
    this.seen.fill(0);
  }

  /**
   * Blend one spectrum (already amplitude-normalised) into angle bin `a`.
   * @param alpha weight kept from previous cycles (0 = instant, ->1 = long memory)
   * @param phaseStep radians per FFT bin to rotate by, compensating the
   *        sub-sample offset between the wanted and the actual frame position
   */
  accumulate(a: number, re: ArrayLike<number>, im: ArrayLike<number>, alpha: number, phaseStep: number): void {
    const K = this.freqBins;
    const base = a * K;
    const keep = this.seen[a] ? alpha : 0;
    const add = 1 - keep;
    // Rotate incrementally: e^{-j k phaseStep}
    const cs = Math.cos(phaseStep);
    const sn = -Math.sin(phaseStep);
    let rr = 1;
    let ri = 0;
    for (let k = 0; k < K; k++) {
      const xr = re[k];
      const xi = im[k];
      const i = base + k;
      this.power[i] = keep * this.power[i] + add * (xr * xr + xi * xi);
      this.cre[i] = keep * this.cre[i] + add * (xr * rr - xi * ri);
      this.cim[i] = keep * this.cim[i] + add * (xr * ri + xi * rr);
      const nr = rr * cs - ri * sn;
      ri = rr * sn + ri * cs;
      rr = nr;
    }
    this.seen[a] = 1;
  }

  /** Rotate the angle axis by `bins` (positive = content moves to later phase). */
  rotate(bins: number): void {
    const A = this.angleBins;
    const s = ((Math.round(bins) % A) + A) % A;
    if (s === 0) return;
    const K = this.freqBins;
    for (const arr of [this.power, this.cre, this.cim]) {
      const tmp = arr.slice();
      for (let a = 0; a < A; a++) arr.set(tmp.subarray(a * K, (a + 1) * K), ((a + s) % A) * K);
    }
    const seen = this.seen.slice();
    for (let a = 0; a < A; a++) this.seen[(a + s) % A] = seen[a];
  }

  /** Strongest power in the grid, dB (reference for display scaling). */
  maxPowerDb(): number {
    let m = 0;
    for (let i = 0; i < this.power.length; i++) if (this.power[i] > m) m = this.power[i];
    return m > 0 ? 10 * Math.log10(m) : DB_FLOOR;
  }

  /** Number of angle bins that hold data. */
  filled(): number {
    let n = 0;
    for (let a = 0; a < this.angleBins; a++) n += this.seen[a];
    return n;
  }

  /**
   * Render the whole grid to bytes: 0 = no data, 1..255 = value.
   * Power and coherent modes share the same dB scale (top = strongest
   * power), so the coherent image shows how much of the power survives.
   */
  render(mode: AccumDisplay, dbTop: number, dbRange: number, out: Uint8Array): void {
    const K = this.freqBins;
    for (let a = 0; a < this.angleBins; a++) {
      const base = a * K;
      if (!this.seen[a]) {
        out.fill(0, base, base + K);
        continue;
      }
      for (let k = 0; k < K; k++) {
        const i = base + k;
        const p = this.power[i];
        let v: number;
        if (mode === 'coherence') {
          const c = this.cre[i] * this.cre[i] + this.cim[i] * this.cim[i];
          // Suppress coherence of bins that hold (almost) nothing: it is undefined there.
          const db = 10 * Math.log10(p + 1e-20);
          v = p > 1e-20 && db > dbTop - dbRange ? Math.min(1, c / p) : 0;
        } else {
          const e = mode === 'power' ? p : this.cre[i] * this.cre[i] + this.cim[i] * this.cim[i];
          const db = 10 * Math.log10(e + 1e-20);
          v = (db - (dbTop - dbRange)) / dbRange;
        }
        out[base + k] = 1 + Math.round(254 * (v < 0 ? 0 : v > 1 ? 1 : v));
      }
    }
  }
}
