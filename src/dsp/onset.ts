export interface Onset {
  /** Audio time of the attack, seconds. */
  time: number;
  /** Flux above the local threshold (arbitrary units, >= 0). */
  strength: number;
  band: number;
}

/**
 * Streaming peak picker over one spectral-flux channel.
 * Adaptive threshold = local mean x ratio + fraction of long-term mean + absolute floor.
 */
export class OnsetDetector {
  private readonly hist: Float32Array;
  private pos = 0;
  private filled = 0;
  private longMean = 0;
  private prev1 = 0;
  private prev2 = 0;
  private prevTime = 0;
  private lastOnset = -Infinity;

  constructor(
    private readonly band: number,
    frameRate: number,
    private readonly ratio = 1.7,
    private readonly floor = 0.004,
    private readonly minInterval = 0.05,
  ) {
    this.hist = new Float32Array(Math.max(4, Math.round(frameRate * 0.4)));
  }

  /** Feed one flux value; returns an onset when the previous frame was a qualifying peak. */
  push(flux: number, time: number, dt: number): Onset | null {
    let localMean = 0;
    for (let i = 0; i < this.filled; i++) localMean += this.hist[i];
    localMean /= this.filled || 1;

    let onset: Onset | null = null;
    const p = this.prev1;
    const thr = this.ratio * localMean + 0.3 * this.longMean + this.floor;
    if (p > this.prev2 && p >= flux && p > thr && this.prevTime - this.lastOnset >= this.minInterval) {
      const d = this.prev2 - 2 * p + flux;
      const shift = d < 0 ? (0.5 * (this.prev2 - flux)) / d : 0;
      onset = { time: this.prevTime + shift * dt, strength: p - localMean, band: this.band };
      this.lastOnset = this.prevTime;
    }

    this.hist[this.pos] = flux;
    this.pos = (this.pos + 1) % this.hist.length;
    if (this.filled < this.hist.length) this.filled++;
    this.longMean += (flux - this.longMean) * Math.min(1, dt / 3);
    this.prev2 = this.prev1;
    this.prev1 = flux;
    this.prevTime = time;
    return onset;
  }
}
