import { FFT, hann } from './fft';

/** Frequency bands for onset analysis. A band is a signal region, not an instrument. */
export const BANDS = [
  { id: 'low', lo: 30, hi: 200 },
  { id: 'mid', lo: 200, hi: 2000 },
  { id: 'high', lo: 2000, hi: 10000 },
] as const;
export const N_BANDS = BANDS.length;

export interface FrameFeatures {
  rms: number;
  /** Positive log-magnitude flux per band. */
  flux: Float32Array;
  /** Mean energy per band (linear amplitude^2). */
  energy: Float32Array;
}

/**
 * Short-time spectral features on a fixed hop: RMS, band energies and
 * band-wise spectral flux of log-compressed magnitude.
 */
export class FeatureExtractor {
  readonly n: number;
  private readonly fft: FFT;
  private readonly win: Float32Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly prevLog: Float32Array;
  private readonly bandBins: Array<[number, number]>;
  private readonly norm: number;
  private first = true;

  constructor(sampleRate: number, n = 1024) {
    this.n = n;
    this.fft = new FFT(n);
    this.win = hann(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.prevLog = new Float32Array(n / 2);
    let s = 0;
    for (let i = 0; i < n; i++) s += this.win[i];
    this.norm = 2 / s;
    const binHz = sampleRate / n;
    this.bandBins = BANDS.map((b) => [Math.max(1, Math.round(b.lo / binHz)), Math.min(n / 2 - 1, Math.round(b.hi / binHz))]);
  }

  /** `frame` must hold `n` samples. */
  process(frame: Float32Array): FrameFeatures {
    const { n, re, im, win } = this;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      sq += frame[i] * frame[i];
      re[i] = frame[i] * win[i];
      im[i] = 0;
    }
    this.fft.forward(re, im);
    const flux = new Float32Array(N_BANDS);
    const energy = new Float32Array(N_BANDS);
    for (let b = 0; b < N_BANDS; b++) {
      const [lo, hi] = this.bandBins[b];
      let f = 0;
      let e = 0;
      for (let k = lo; k <= hi; k++) {
        const mag = Math.hypot(re[k], im[k]) * this.norm;
        e += mag * mag;
        const l = Math.log1p(1000 * mag);
        const d = l - this.prevLog[k];
        if (d > 0) f += d;
        this.prevLog[k] = l;
      }
      const cnt = hi - lo + 1;
      flux[b] = this.first ? 0 : f / cnt;
      energy[b] = e / cnt;
    }
    this.first = false;
    return { rms: Math.sqrt(sq / n), flux, energy };
  }
}
