/**
 * Analysis engine: audio samples in, rhythm state out.
 *
 * Pure TypeScript with no Web Audio dependency: runs inside a Web Worker in
 * the app and directly in Node for tests. All times are audio-clock seconds
 * (sample frame / sampleRate), identical to AudioContext.currentTime.
 *
 * Pipeline per hop:   samples -> FeatureExtractor (RMS, band energy, flux)
 *                     -> OnsetDetector per band -> EventAccumulator
 *                     -> onset envelope -> tempo (ACF) + beat phase (comb)
 *                     -> Transport (PLL-like, slew-limited phase correction)
 * Per phase slot:     samples at an exact cycle position -> FFT
 *                     -> PolarSpectrogram (power + complex accumulators)
 */
import { FFT, hann } from '../dsp/fft';
import { FeatureExtractor, N_BANDS } from '../dsp/features';
import { OnsetDetector } from '../dsp/onset';
import { combResponse, estimateBeatPhase, estimateTempo, type TempoEstimate } from '../dsp/tempo';
import { EventAccumulator } from '../accumulate/event-accumulator';
import { PolarSpectrogram, type AccumDisplay } from '../accumulate/polar-spectrogram';
import { Transport } from './transport';
import { clamp, frac, wrapHalf } from '../util/math';

export const ALGORITHM_VERSION = 'srr-analysis-0.1.0';

export type ClockMode = 'auto' | 'manual' | 'reference';

export interface EngineSettings {
  /** Beats per dial revolution: 8 (two bars) or 4 (one bar). */
  cycleBeats: number;
  /** Accumulation memory in cycles; 1 = instant (only the latest cycle). */
  memoryCycles: number;
  display: AccumDisplay;
  dbRange: number;
  /** Tempo search octave is [bpmLo, 2*bpmLo): resolves the 90/180 ambiguity explicitly. */
  bpmLo: number;
  /** Highest frequency kept in the polar spectrogram, Hz. */
  fmax: number;
  /** Continuous phase correction from the beat tracker. */
  autoPhase: boolean;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  cycleBeats: 8,
  memoryCycles: 8,
  display: 'power',
  dbRange: 60,
  bpmLo: 120,
  fmax: 5000,
  autoPhase: true,
};

/** Number of event-density channels: one per band + combined. */
export const N_CHANNELS = N_BANDS + 1;
export const CHANNEL_ALL = N_BANDS;

export interface ObservedOnset {
  time: number;
  channel: number;
  strength: number;
  /** Cycle phase 0..1 under the clock at detection time. */
  phase: number;
}

export interface ClockState {
  mode: ClockMode;
  tRef: number;
  beatRef: number;
  bpm: number;
  offset: number;
  cycleBeats: number;
}

export interface TrackerState {
  locked: boolean;
  bpm: number;
  confidence: number;
  phaseStrength: number;
  candidates: TempoEstimate['candidates'];
  /** Tracker vs reference clock (Demo only). */
  refPhaseErrorMs: number | null;
  refBpmError: number | null;
}

export interface EngineSnapshot {
  algorithm: string;
  time: number;
  clock: ClockState;
  tracker: TrackerState;
  onsets: ObservedOnset[];
  density: Float32Array;
  densityBins: number;
  spec: Uint8Array | null;
  specAngleBins: number;
  specFreqBins: number;
  specBinHz: number;
  cycles: number;
  stats: {
    rms: number;
    bandEnergyDb: number[];
    onsetCounts: number[];
    hopsPerSec: number;
    msPerSecondOfAudio: number;
    samplesIn: number;
  };
}

const RING = 1 << 18;
/** Systematic delay between an attack and the flux peak of the hop it falls in. Calibrated in tests. */
const ONSET_LAG = 0;
/** Mean-square level below which a spectrogram frame counts as silence (-80 dBFS). */
const SILENCE_MS = 1e-8;
/** Consecutive tempo updates (0.5 s each) that must agree before a half-beat phase jump. */
const FLIP_VOTES = 4;
/** A half-beat jump needs the comb response at the new phase to exceed the current one by this factor. */
const FLIP_MARGIN = 1.15;

export class AnalysisEngine {
  readonly sr: number;
  readonly hop: number;
  readonly envRate: number;
  readonly specN: number;
  readonly angleBins = 256;
  readonly densityBins = 128;
  settings: EngineSettings;

  readonly tracker = new Transport();
  private readonly fixedClock = new Transport();
  private mode: ClockMode = 'auto';

  private readonly ring = new Float32Array(RING);
  private head = -1;
  private hopEnd = 0;
  private samplesIn = 0;

  private features: FeatureExtractor;
  private onsetDetectors: OnsetDetector[] = [];
  private readonly envLen: number;
  private readonly env: Float32Array;
  private envPos = 0;
  private envCount = 0;
  private envEndTime = 0;
  private hopsSinceTempo = 0;

  private locked = false;
  private candBpm = 0;
  private candCount = 0;
  private disagree = 0;
  private lowConf = 0;
  private lastEstimate: TempoEstimate = { bpm: 0, confidence: 0, candidates: [] };
  private phaseStrength = 0;
  private flipVotes = 0;
  private refPhaseErrorMs: number | null = null;
  private refBpmError: number | null = null;

  readonly events: EventAccumulator;
  private spec: PolarSpectrogram;
  private specFFT: FFT;
  private specWin: Float32Array;
  private specNorm = 1;
  private readonly specRe: Float64Array;
  private readonly specIm: Float64Array;
  private nextSlot = Number.NaN;
  private cycles = 0;

  private pendingOnsets: ObservedOnset[] = [];
  private onsetCounts = new Array<number>(N_CHANNELS).fill(0);
  private rms = 0;
  private bandEnergy = new Float32Array(N_BANDS);
  private workMs = 0;
  private workAudioS = 0;
  private hopsCount = 0;

  constructor(sampleRate: number, settings: Partial<EngineSettings> = {}) {
    this.sr = sampleRate;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.hop = sampleRate > 60000 ? 1024 : 512;
    this.envRate = sampleRate / this.hop;
    this.specN = sampleRate > 60000 ? 4096 : 2048;
    this.features = new FeatureExtractor(sampleRate, this.hop * 2);
    this.resetOnsetDetectors();
    this.envLen = Math.round(this.envRate * 8);
    this.env = new Float32Array(this.envLen);
    this.events = new EventAccumulator(N_CHANNELS, this.densityBins);
    this.specFFT = new FFT(this.specN);
    this.specWin = hann(this.specN);
    let s = 0;
    for (let i = 0; i < this.specN; i++) s += this.specWin[i];
    this.specNorm = 2 / s;
    this.specRe = new Float64Array(this.specN);
    this.specIm = new Float64Array(this.specN);
    this.spec = new PolarSpectrogram(this.angleBins, this.specBinsFor(this.settings.fmax));
    this.tracker.bpm = 2 * this.settings.bpmLo * 0.75;
  }

  // ---------------------------------------------------------------- clock

  get clock(): Transport {
    return this.mode === 'auto' ? this.tracker : this.fixedClock;
  }

  get clockMode(): ClockMode {
    return this.mode;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Current analysis time: the newest sample. */
  get now(): number {
    return this.head < 0 ? 0 : this.head / this.sr;
  }

  setClockMode(mode: ClockMode): void {
    if (mode === this.mode) return;
    const t = this.now;
    if (mode !== 'auto' && this.mode === 'auto') {
      this.fixedClock.anchor(t, this.tracker.beatsAt(t), this.tracker.bpm);
      this.fixedClock.offset = this.tracker.offset;
    } else if (mode === 'auto') {
      // Keep which beat is count 1: carry the integer beat difference into the tracker offset.
      this.tracker.offset = Math.round(this.fixedClock.cycleBeatsAt(t) - this.tracker.beatsAt(t));
    }
    this.mode = mode;
    this.resyncSlots();
  }

  /** Ground truth clock (Demo): count 1 at beat 0. */
  setReference(tRef: number, beatRef: number, bpm: number): void {
    this.fixedClock.anchor(tRef, beatRef, bpm);
    this.fixedClock.offset = 0;
    if (this.mode !== 'reference') this.mode = 'reference';
    this.resetAccumulators();
  }

  setBpm(bpm: number): void {
    const t = this.now;
    if (this.mode === 'auto') {
      this.tracker.setBpm(bpm, t);
      this.settings.bpmLo = octaveLo(bpm, this.settings.bpmLo);
      this.locked = true;
      this.candBpm = bpm;
      this.disagree = 0;
    } else {
      this.fixedClock.setBpm(bpm, t);
    }
    this.resetAccumulators();
  }

  /** Double or halve the tempo (and, in auto mode, the search octave). */
  scaleBpm(factor: number): void {
    const t = this.now;
    if (this.mode === 'auto') {
      this.settings.bpmLo = clamp(this.settings.bpmLo * factor, 30, 240);
      this.tracker.setBpm(this.tracker.bpm * factor, t);
      this.candBpm = 0;
    } else {
      this.fixedClock.setBpm(this.fixedClock.bpm * factor, t);
    }
    this.resetAccumulators();
  }

  /** Declare that count 1 is (the beat nearest to) audio time t. */
  setCountOne(t: number): void {
    const c = this.clock;
    const cb = this.settings.cycleBeats;
    const cur = c.cycleBeatsAt(t);
    const exact = this.mode === 'manual';
    const target = exact ? cur : Math.round(cur);
    let shift = -(((target % cb) + cb) % cb);
    if (shift < -cb / 2) shift += cb;
    c.offset += shift;
    this.rotateAccumulators(shift);
  }

  /** Shift which part of the cycle is shown at the top, in beats. */
  nudge(beats: number): void {
    this.clock.offset += beats;
    this.rotateAccumulators(beats);
  }

  /** Tap tempo: times are audio-clock seconds of the user's taps. */
  applyTaps(times: number[]): void {
    if (times.length < 2) return;
    const iv: number[] = [];
    for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[iv.length >> 1];
    if (!(med > 0.1 && med < 2)) return;
    const bpm = 60 / med;
    const last = times[times.length - 1];
    const c = this.clock;
    const b = c.beatsAt(last);
    c.anchor(last, Math.round(b), bpm);
    if (this.mode === 'auto') {
      this.settings.bpmLo = octaveLo(bpm, this.settings.bpmLo);
      this.locked = true;
      this.candBpm = bpm;
      this.disagree = 0;
    }
    this.resetAccumulators();
  }

  updateSettings(s: Partial<EngineSettings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...s };
    if (s.fmax !== undefined && this.specBinsFor(s.fmax) !== this.spec.freqBins) {
      this.spec = new PolarSpectrogram(this.angleBins, this.specBinsFor(s.fmax));
      this.resyncSlots();
    }
    if (s.cycleBeats !== undefined && s.cycleBeats !== prev.cycleBeats) this.resetAccumulators();
    if (s.bpmLo !== undefined && s.bpmLo !== prev.bpmLo && this.mode === 'auto') {
      this.locked = false;
      this.candBpm = 0;
    }
  }

  // ---------------------------------------------------------------- input

  /** Feed mono samples whose first sample has absolute frame index `startFrame`. */
  push(startFrame: number, samples: Float32Array): void {
    const t0 = nowMs();
    let src = samples;
    if (this.head < 0) {
      this.head = startFrame;
      this.hopEnd = startFrame + this.features.n;
    } else if (startFrame > this.head) {
      const gap = startFrame - this.head;
      if (gap > RING / 2) {
        this.discontinuity();
        this.head = startFrame;
        this.hopEnd = startFrame + this.features.n;
      } else {
        for (let i = 0; i < gap; i++) this.ring[(this.head + i) & (RING - 1)] = 0;
        this.head += gap;
      }
    } else if (startFrame < this.head) {
      const skip = this.head - startFrame;
      if (skip >= samples.length) return;
      src = samples.subarray(skip);
    }
    for (let i = 0; i < src.length; i++) this.ring[(this.head + i) & (RING - 1)] = src[i];
    this.head += src.length;
    this.samplesIn += src.length;

    while (this.hopEnd <= this.head) {
      this.processHop(this.hopEnd);
      this.hopEnd += this.hop;
    }
    this.processSlots();
    this.workMs += nowMs() - t0;
    this.workAudioS += src.length / this.sr;
  }

  /** Forget the signal history (seek, source change). Clock and settings stay. */
  discontinuity(): void {
    this.head = -1;
    this.features = new FeatureExtractor(this.sr, this.hop * 2);
    this.resetOnsetDetectors();
    this.env.fill(0);
    this.envCount = 0;
    this.envPos = 0;
    this.locked = this.mode !== 'auto' ? this.locked : false;
    this.candBpm = 0;
    this.resetAccumulators();
  }

  resetAccumulators(): void {
    this.events.reset();
    this.spec.reset();
    this.cycles = 0;
    this.nextSlot = Number.NaN;
  }

  // ---------------------------------------------------------------- per hop

  private readonly hopFrame = new Float32Array(4096);

  private processHop(end: number): void {
    const n = this.features.n;
    const frame = this.hopFrame.subarray(0, n);
    for (let i = 0; i < n; i++) frame[i] = this.ring[(end - n + i) & (RING - 1)];
    const f = this.features.process(frame);
    const t = (end - n / 2) / this.sr;
    const dt = this.hop / this.sr;
    this.hopsCount++;

    this.rms += (f.rms - this.rms) * 0.1;
    for (let b = 0; b < N_BANDS; b++) this.bandEnergy[b] += (f.energy[b] - this.bandEnergy[b]) * 0.1;

    let all = 0;
    for (let b = 0; b < N_BANDS; b++) all += f.flux[b];

    const clock = this.clock;
    const cb = this.settings.cycleBeats;
    const alpha = memoryAlpha(this.settings.memoryCycles);
    this.events.sweep(frac(clock.cycleBeatsAt(t) / cb), alpha);
    for (let ch = 0; ch < N_CHANNELS; ch++) {
      const o = this.onsetDetectors[ch].push(ch === CHANNEL_ALL ? all : f.flux[ch], t, dt);
      if (o) {
        const ot = o.time - ONSET_LAG;
        const phase = frac(clock.cycleBeatsAt(ot) / cb);
        this.events.add(ch, phase, Math.min(o.strength, 4));
        this.onsetCounts[ch]++;
        if (this.pendingOnsets.length < 256) this.pendingOnsets.push({ time: ot, channel: ch, strength: o.strength, phase });
      }
    }

    this.env[this.envPos] = all;
    this.envPos = (this.envPos + 1) % this.envLen;
    if (this.envCount < this.envLen) this.envCount++;
    this.envEndTime = t;

    this.tracker.advance(t, dt);
    if (this.mode !== 'auto') this.fixedClock.advance(t, dt);

    if (++this.hopsSinceTempo >= Math.round(this.envRate * 0.5)) {
      this.hopsSinceTempo = 0;
      this.updateTempo(t);
    }
  }

  private envLinear(): Float32Array {
    const out = new Float32Array(this.envCount);
    const start = (this.envPos - this.envCount + this.envLen) % this.envLen;
    for (let i = 0; i < this.envCount; i++) out[i] = this.env[(start + i) % this.envLen];
    return out;
  }

  private updateTempo(t: number): void {
    // Shorter windows flip between the beat and the 1.5-beat (tresillo) period.
    if (this.envCount < this.envRate * 5) return;
    const env = this.envLinear();
    const lo = this.settings.bpmLo;
    const est = estimateTempo(env, this.envRate, lo, 2 * lo);
    this.lastEstimate = est;
    const tr = this.tracker;

    if (est.confidence < 0.08) {
      if (++this.lowConf > 6) this.locked = false;
      this.updateReferenceError(t);
      return;
    }
    this.lowConf = 0;

    if (!this.locked) {
      if (this.candBpm > 0 && Math.abs(est.bpm - this.candBpm) / this.candBpm < 0.03) this.candCount++;
      else {
        this.candBpm = est.bpm;
        this.candCount = 1;
      }
      if (this.candCount >= 3) {
        tr.setBpm(est.bpm, t);
        this.snapPhase(env, true);
        this.locked = true;
        this.disagree = 0;
        if (this.mode === 'auto') this.resetAccumulators();
      }
      this.updateReferenceError(t);
      return;
    }

    const rel = (est.bpm - tr.bpm) / tr.bpm;
    if (Math.abs(rel) < 0.04) {
      tr.setBpm(tr.bpm + 0.3 * (est.bpm - tr.bpm), t);
      this.disagree = 0;
    } else if (++this.disagree >= 4) {
      this.locked = false;
      this.candBpm = 0;
    }
    if (this.settings.autoPhase) this.snapPhase(env, false);
    this.updateReferenceError(t);
  }

  private snapPhase(env: Float32Array, hard: boolean): void {
    const tr = this.tracker;
    const period = (this.envRate * 60) / tr.bpm;
    const bp = estimateBeatPhase(env, period);
    this.phaseStrength = bp.strength;
    if (bp.strength < 0.05) return;
    const tBeat = this.envEndTime - bp.offset / this.envRate - ONSET_LAG;
    const b = tr.beatsAt(tBeat);
    const err = Math.round(b) - b;
    if (hard) {
      tr.anchor(tBeat, Math.round(b), tr.bpm);
      this.flipVotes = 0;
    } else {
      // Beat vs off-beat ("&") is genuinely ambiguous in salsa (anticipated bass,
      // offbeat piano, conga 4&): a half-beat jump is only accepted when the new
      // phase is clearly stronger than the current grid AND that persists
      // (hysteresis). Small errors are corrected right away.
      if (Math.abs(err) > 0.25) {
        const bEnd = tr.beatsAt(this.envEndTime - ONSET_LAG);
        const curOffset = (bEnd - Math.floor(bEnd)) * period;
        const respCur = combResponse(env, period, curOffset);
        const respNew = combResponse(env, period, bp.offset);
        if (respNew < FLIP_MARGIN * respCur) {
          this.flipVotes = 0;
          return;
        }
        if (++this.flipVotes < FLIP_VOTES) return;
      }
      this.flipVotes = 0;
      tr.setCorrection(0.6 * err);
      // Weak integral path: a persistent phase error means the tempo is slightly off.
      // Kept small — the ACF estimate already steers tempo; a strong I-term oscillates.
      const adj = clamp(2 * err, -0.003 * tr.bpm, 0.003 * tr.bpm);
      tr.setBpm(tr.bpm + adj, this.envEndTime);
    }
  }

  private updateReferenceError(t: number): void {
    if (this.mode !== 'reference' || !this.locked) {
      this.refPhaseErrorMs = null;
      this.refBpmError = null;
      return;
    }
    const ref = this.fixedClock;
    const d = wrapHalf(this.tracker.beatsAt(t) - ref.beatsAt(t));
    this.refPhaseErrorMs = (d * 60000) / ref.bpm;
    this.refBpmError = this.tracker.bpm - ref.bpm;
  }

  // ---------------------------------------------------------------- per slot

  private specBinsFor(fmax: number): number {
    return Math.min(this.specN / 2, Math.ceil(fmax / (this.sr / this.specN)) + 1);
  }

  private resyncSlots(): void {
    this.nextSlot = Number.NaN;
  }

  private processSlots(): void {
    const N = this.specN;
    const A = this.angleBins;
    const cb = this.settings.cycleBeats;
    const clock = this.clock;
    if (Number.isNaN(this.nextSlot)) {
      const tAvail = (this.head - N / 2) / this.sr;
      this.nextSlot = Math.floor((clock.cycleBeatsAt(tAvail) / cb) * A) + 1;
    }
    const alpha = memoryAlpha(this.settings.memoryCycles);
    const K = this.spec.freqBins;
    for (let guard = 0; guard < A; guard++) {
      const s = this.nextSlot;
      const t = clock.timeAtCycleBeats((s * cb) / A);
      const start = t * this.sr - N / 2;
      const s0 = Math.floor(start);
      if (s0 + N > this.head) return;
      if (s0 < this.head - RING + N) {
        this.resyncSlots();
        return;
      }
      const delta = start - s0;
      const re = this.specRe;
      const im = this.specIm;
      let ms = 0;
      for (let i = 0; i < N; i++) {
        const x = this.ring[(s0 + i) & (RING - 1)];
        ms += x * x;
        re[i] = x * this.specWin[i] * this.specNorm;
        im[i] = 0;
      }
      const a = ((s % A) + A) % A;
      this.nextSlot = s + 1;
      if (a === A - 1) this.cycles++;
      // No signal is no observation: silent frames (< -80 dBFS) are not accumulated,
      // so lead-in silence or pauses neither dilute power nor fake incoherence.
      if (ms / N < SILENCE_MS) continue;
      this.specFFT.forward(re, im);
      // Frame starts `delta` samples early: X_wanted[k] = X[k] e^{+j 2 pi k delta / N}.
      this.spec.accumulate(a, re.subarray(0, K), im.subarray(0, K), alpha, (-2 * Math.PI * delta) / N);
    }
  }

  private rotateAccumulators(beats: number): void {
    const cb = this.settings.cycleBeats;
    this.events.rotate((beats / cb) * this.densityBins);
    this.spec.rotate((beats / cb) * this.angleBins);
    this.resyncSlots();
  }

  private resetOnsetDetectors(): void {
    const fr = this.sr / this.hop;
    this.onsetDetectors = [];
    for (let ch = 0; ch < N_CHANNELS; ch++) this.onsetDetectors.push(new OnsetDetector(ch, fr));
  }

  // ---------------------------------------------------------------- output

  snapshot(withSpec = true): EngineSnapshot {
    const c = this.clock;
    let spec: Uint8Array | null = null;
    if (withSpec) {
      spec = new Uint8Array(this.angleBins * this.spec.freqBins);
      this.spec.render(this.settings.display, this.spec.maxPowerDb(), this.settings.dbRange, spec);
    }
    const onsets = this.pendingOnsets;
    this.pendingOnsets = [];
    const snap: EngineSnapshot = {
      algorithm: ALGORITHM_VERSION,
      time: this.now,
      clock: { mode: this.mode, tRef: c.tRef, beatRef: c.beatRef, bpm: c.bpm, offset: c.offset, cycleBeats: this.settings.cycleBeats },
      tracker: {
        locked: this.locked,
        bpm: this.tracker.bpm,
        confidence: this.locked ? this.lastEstimate.confidence : 0,
        phaseStrength: this.phaseStrength,
        candidates: this.lastEstimate.candidates,
        refPhaseErrorMs: this.refPhaseErrorMs,
        refBpmError: this.refBpmError,
      },
      onsets,
      density: this.events.density.slice(),
      densityBins: this.densityBins,
      spec,
      specAngleBins: this.angleBins,
      specFreqBins: this.spec.freqBins,
      specBinHz: this.sr / this.specN,
      cycles: this.cycles,
      stats: {
        rms: this.rms,
        bandEnergyDb: Array.from(this.bandEnergy, (e) => 10 * Math.log10(e + 1e-12)),
        onsetCounts: [...this.onsetCounts],
        hopsPerSec: this.envRate,
        msPerSecondOfAudio: this.workAudioS > 0 ? this.workMs / this.workAudioS : 0,
        samplesIn: this.samplesIn,
      },
    };
    return snap;
  }
}

/** Per-revisit retention for a memory of `n` cycles (1 = keep nothing). */
export function memoryAlpha(n: number): number {
  return n <= 1 ? 0 : Math.exp(-1 / n);
}

/** Lower bound of the tempo octave that contains bpm, preferring the current one. */
function octaveLo(bpm: number, current: number): number {
  if (bpm >= current && bpm < 2 * current) return current;
  return clamp(bpm / Math.SQRT2, 30, 240);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
