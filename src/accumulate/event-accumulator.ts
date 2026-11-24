/**
 * Polar density of observed onsets, per frequency band, in musical phase.
 * No quantisation to the rhythmic grid: bins are fine (360/bins degrees) and
 * each onset is split linearly between its two neighbouring bins, so
 * microtiming survives accumulation.
 *
 * Ageing is per revisit: when the playhead sweeps over a bin, what earlier
 * cycles left there is multiplied by alpha before new onsets can land.
 */
export class EventAccumulator {
  readonly density: Float32Array;
  private lastBin = -1;

  constructor(
    readonly bands: number,
    readonly bins: number,
  ) {
    this.density = new Float32Array(bands * bins);
  }

  reset(): void {
    this.density.fill(0);
    this.lastBin = -1;
  }

  /** Advance the playhead to cycle phase (0..1), ageing every bin it crosses. */
  sweep(phase: number, alpha: number): void {
    const bin = Math.floor(phase * this.bins) % this.bins;
    if (this.lastBin < 0) {
      this.lastBin = bin;
      return;
    }
    let steps = (bin - this.lastBin + this.bins) % this.bins;
    if (steps > this.bins / 2) steps = 0; // playhead moved backwards (correction): do not age
    for (let s = 1; s <= steps; s++) {
      const b = (this.lastBin + s) % this.bins;
      for (let band = 0; band < this.bands; band++) this.density[band * this.bins + b] *= alpha;
    }
    if (steps > 0) this.lastBin = bin;
  }

  /** Rotate the phase axis by `bins` (positive = content moves to later phase). */
  rotate(bins: number): void {
    const s = ((Math.round(bins) % this.bins) + this.bins) % this.bins;
    if (s === 0) return;
    const tmp = this.density.slice();
    for (let band = 0; band < this.bands; band++) {
      for (let b = 0; b < this.bins; b++) {
        this.density[band * this.bins + ((b + s) % this.bins)] = tmp[band * this.bins + b];
      }
    }
    this.lastBin = -1;
  }

  add(band: number, phase: number, strength: number): void {
    const x = phase * this.bins;
    const i = Math.floor(x);
    const f = x - i;
    const b0 = ((i % this.bins) + this.bins) % this.bins;
    const b1 = (b0 + 1) % this.bins;
    this.density[band * this.bins + b0] += strength * (1 - f);
    this.density[band * this.bins + b1] += strength * f;
  }
}
