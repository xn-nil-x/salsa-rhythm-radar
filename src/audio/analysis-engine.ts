/**
 * Analysis engine: audio samples in, rhythm state out.
 *
 * Pure TypeScript with no Web Audio dependency: runs inside a Web Worker in
 * the app and directly in Node for tests. All times are audio-clock seconds
 * (sample frame / sampleRate), identical to AudioContext.currentTime.
 *
 *  hop 512:   samples -> FeatureExtractor (RMS, band energy, flux)
 *             -> OnsetDetector per band -> onset history ("tape")
 *             -> onset envelope (30 s)
 *  every 0.5 s: hierarchical epoch folding of the envelope over the whole
 *             8-count cycle -> tempo + confidence; folded profile x salsa
 *             template -> beat phase and count 1 -> Transport (smooth
 *             glides, slew-limited phase correction)
 *  hop 1024:  FFT 2048 -> complex spectrum history ("tape")
 *  display:   onset and spectrum histories are re-folded with the CURRENT
 *             clock, so the accumulated image follows tempo/phase changes
 *             instead of being reset.
 */
import { FFT, hann } from '../dsp/fft';
import { FeatureExtractor, N_BANDS } from '../dsp/features';
import { OnsetDetector } from '../dsp/onset';
import { beatGrid, fold, refinePeriodByOnsets, searchCycle, type CycleSearch, type FoldOptions } from '../dsp/folding';
import { FoldedSpectrogram, FrameHistory, foldOnsets, type AccumDisplay, type OnsetRecord } from '../accumulate/folded';
import { PhosphorScreen } from '../accumulate/phosphor';
import { patternPhases, getPattern } from '../rhythm/library';
import { patternProfile } from '../rhythm/matching';
import type { ClaveDirection } from '../rhythm/types';
import { Transport } from './transport';
import { clamp, frac, wrapHalf } from '../util/math';

export const ALGORITHM_VERSION = 'srr-analysis-0.4.0';

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
  /** Highest frequency shown in the polar spectrogram, Hz. */
  fmax: number;
  /** Continuous phase correction from the beat tracker. */
  autoPhase: boolean;
  /** Find count 1 automatically from the salsa rhythm template. */
  autoDownbeat: boolean;
  /** Clave direction assumed by the phase template. */
  clave: ClaveDirection;
  /**
   * How the tape is folded: 'refold' = the whole history with the CURRENT clock
   * (default: tempo refinements re-align all of it); 'recorded' = each observation
   * keeps the beat it was given when recorded (real tempo changes do not smear it).
   */
  tapeMode: 'refold' | 'recorded';
  /**
   * How the polar spectrogram accumulates: 'phosphor' = CRT-like screen, each cell
   * moves 1/N of the way to every new observation (fades away in ~3N cycles);
   * 'tape' = the history refolded with exponential weights.
   */
  specRender: 'phosphor' | 'tape';
}

export const DEFAULT_SETTINGS: EngineSettings = {
  cycleBeats: 8,
  memoryCycles: 8,
  display: 'power',
  dbRange: 60,
  bpmLo: 120,
  fmax: 5000,
  autoPhase: true,
  autoDownbeat: true,
  clave: '3-2',
  tapeMode: 'refold',
  specRender: 'phosphor',
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

export type ConfidenceLevel = 'none' | 'weak' | 'likely' | 'reliable';

export interface TrackerState {
  locked: boolean;
  bpm: number;
  /** 0..1 summary for meters; see `level` for the meaning. */
  confidence: number;
  level: ConfidenceLevel;
  /** How many times clearer than noise the folded rhythm is (≈1 = no rhythm). */
  sharpness: number;
  /** Best hypothesis vs the strongest different one (1 = tie). */
  margin: number;
  /** Competing tempo hypotheses, strongest first (score = sharpness). */
  candidates: Array<{ bpm: number; score: number }>;
  /** Phase evidence: template (or comb) on-beat vs half-beat-shifted (≥1). */
  phaseStrength: number;
  phaseMethod: 'template' | 'comb';
  /** Pearson r of the folded cycle profile with the salsa template (-1..1). */
  templateR: number;
  /** Adaptive depth of the tempo fold, in cycles. */
  depthCycles: number;
  downbeat: 'auto' | 'user' | 'off';
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
/** Mean-square level below which a spectrogram frame counts as silence (-80 dBFS). */
const SILENCE_MS = 1e-8;
/** Systematic delay of detected onsets (flux peak) after the true attack, seconds. Calibrated with the benchmark. */
const ONSET_LAG = 0.002;
/** Onset envelope kept for tempo folding, seconds. */
const ENV_SECONDS = 30;
/** Maximum history of the "tape" (spectra and onsets), seconds. */
const MAX_HISTORY = 90;
/** Tempo folding: phase bins per cycle. */
const FOLD_BINS = 64;
/** Adaptive memory depth of the tempo fold, in cycles (see docs/research/TEMPO.md §7). */
const DEPTH_MIN = 1.5;
const DEPTH_MAX = 6;
const DEPTH_STEP = 0.25;
/** Short window used to rank hypotheses (reacts fast to tempo changes), cycles. */
const RANK_DEPTH = 1.5;
/** Maximum depth of the fold used for beat phase, cycles. */
const PHASE_DEPTH = 3;
/** Consecutive updates (0.5 s each) needed to accept a half-beat phase jump / tempo switch / new count 1. */
const FLIP_VOTES = 4;
const SWITCH_VOTES = 2;
const DOWNBEAT_VOTES = 3;
/** Required evidence ratio for a half-beat jump. */
const FLIP_MARGIN = 1.3;
/** Minimum Pearson r between folded profile and salsa template for the template to decide the phase. */
const TEMPLATE_MIN_R = 0.35;

/** Confidence thresholds, calibrated on the synthetic benchmark (docs/research/TEMPO.md). */
export function confidenceOf(s: CycleSearch | null): { level: ConfidenceLevel; value: number; sharpness: number; margin: number } {
  if (!s?.best) return { level: 'none', value: 0, sharpness: 0, margin: 0 };
  const sh = s.best.sharpness;
  const m = Number.isFinite(s.margin) ? s.margin : 3;
  const level: ConfidenceLevel = sh >= 6 && m >= 1.6 ? 'reliable' : sh >= 4 && m >= 1.3 ? 'likely' : sh >= 2.5 ? 'weak' : 'none';
  const a = clamp(Math.log(sh / 2) / Math.log(12 / 2), 0, 1);
  const b = clamp((m - 1) / 0.8, 0, 1);
  return { level, value: Math.sqrt(a * b), sharpness: sh, margin: m };
}

export class AnalysisEngine {
  readonly sr: number;
  readonly hop: number;
  readonly envRate: number;
  readonly specN: number;
  readonly specHop: number;
  readonly angleBins = 256;
  readonly densityBins = 128;
  settings: EngineSettings;

  readonly tracker = new Transport();
  private readonly fixedClock = new Transport();
  private mode: ClockMode = 'auto';

  private readonly ring = new Float32Array(RING);
  private head = -1;
  private hopEnd = 0;
  private specEnd = 0;
  private samplesIn = 0;

  private features: FeatureExtractor;
  private onsetDetectors: OnsetDetector[] = [];
  private readonly envLen: number;
  private readonly env: Float32Array;
  private envPos = 0;
  private envCount = 0;
  private envEndTime = 0;
  private hopsSinceTempo = 0;

  // tracker state
  private locked = false;
  private candPeriod = 0;
  private candCount = 0;
  private switchPeriod = 0;
  private switchVotes = 0;
  private flipVotes = 0;
  private downVotes = 0;
  private downTarget = 0;
  private lowConf = 0;
  private userDownbeat = false;
  private lastSearch: CycleSearch | null = null;
  /** Current depth of the precise tempo/phase fold, in cycles. */
  private depthCycles = 2;
  private phaseStrength = 0;
  private templateR = 0;
  private phaseMethod: 'template' | 'comb' = 'comb';
  private refPhaseErrorMs: number | null = null;
  private refBpmError: number | null = null;
  private readonly templates: Record<ClaveDirection, Float32Array>;

  // the "tape"
  private onsetHist: OnsetRecord[] = [];
  private readonly frames: FrameHistory;
  private spec: FoldedSpectrogram;
  private phosphor: PhosphorScreen;
  private readonly specFFT: FFT;
  private readonly specWin: Float32Array;
  private readonly specNorm: number;
  private readonly specRe: Float64Array;
  private readonly specIm: Float64Array;
  private lastRebuild = -Infinity;

  private pendingOnsets: ObservedOnset[] = [];
  private onsetCounts = new Array<number>(N_CHANNELS).fill(0);
  private rms = 0;
  private bandEnergy = new Float32Array(N_BANDS);
  private workMs = 0;
  private workAudioS = 0;

  constructor(sampleRate: number, settings: Partial<EngineSettings> = {}) {
    this.sr = sampleRate;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.hop = sampleRate > 60000 ? 1024 : 512;
    this.envRate = sampleRate / this.hop;
    this.specN = sampleRate > 60000 ? 4096 : 2048;
    this.specHop = this.specN / 2;
    this.features = new FeatureExtractor(sampleRate, this.hop * 2);
    this.resetOnsetDetectors();
    this.envLen = Math.round(this.envRate * ENV_SECONDS);
    this.env = new Float32Array(this.envLen);
    this.specFFT = new FFT(this.specN);
    this.specWin = hann(this.specN);
    let s = 0;
    for (let i = 0; i < this.specN; i++) s += this.specWin[i];
    this.specNorm = 2 / s;
    this.specRe = new Float64Array(this.specN);
    this.specIm = new Float64Array(this.specN);
    // History keeps spectra up to 10 kHz so the display range can change without losing data.
    const histBins = Math.min(this.specN / 2, Math.ceil(10000 / (sampleRate / this.specN)) + 1);
    this.frames = new FrameHistory(Math.ceil((MAX_HISTORY * sampleRate) / this.specHop), histBins);
    this.spec = new FoldedSpectrogram(this.angleBins, this.specBinsFor(this.settings.fmax));
    this.phosphor = new PhosphorScreen(this.angleBins, this.spec.freqBins);
    this.tracker.bpm = 1.5 * this.settings.bpmLo;
    this.templates = { '3-2': buildTemplate('3-2', FOLD_BINS), '2-3': buildTemplate('2-3', FOLD_BINS) };
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

  private cycleDur(): number {
    return (this.settings.cycleBeats * 60) / this.clock.bpm;
  }

  /**
   * Correction between beat numbers recorded under an earlier clock and the
   * current clock's numbering (changes when the clock is switched or re-anchored).
   */
  private beatsBias = 0;

  private phaseOf = (t: number, recorded: number): number => {
    const c = this.clock;
    if (this.settings.tapeMode === 'recorded') return frac((recorded + this.beatsBias + c.offset) / this.settings.cycleBeats);
    return frac(c.cycleBeatsAt(t) / this.settings.cycleBeats);
  };

  /** Run a clock change and keep recorded beat numbers consistent with the new numbering. */
  private renumber(change: () => void): void {
    const t = this.now;
    const before = this.clock.beatsAt(t);
    change();
    this.beatsBias += this.clock.beatsAt(t) - before;
  }

  setClockMode(mode: ClockMode): void {
    if (mode === this.mode) return;
    this.renumber(() => this.applyClockMode(mode));
  }

  private applyClockMode(mode: ClockMode): void {
    const t = this.now;
    if (mode !== 'auto' && this.mode === 'auto') {
      this.fixedClock.anchor(t, this.tracker.beatsAt(t), this.tracker.bpm);
      this.fixedClock.offset = this.tracker.offset;
    } else if (mode === 'auto') {
      // Keep which beat is count 1: carry the integer beat difference into the tracker offset.
      this.tracker.offset = Math.round(this.fixedClock.cycleBeatsAt(t) - this.tracker.beatsAt(t));
    }
    this.mode = mode;
  }

  /** Ground truth clock (Demo): count 1 at beat 0. */
  setReference(tRef: number, beatRef: number, bpm: number): void {
    this.renumber(() => {
      this.fixedClock.anchor(tRef, beatRef, bpm);
      this.fixedClock.offset = 0;
      this.mode = 'reference';
    });
  }

  setBpm(bpm: number): void {
    if (this.mode === 'auto') {
      this.tracker.glideBpm(bpm);
      this.settings.bpmLo = octaveLo(bpm, this.settings.bpmLo);
      this.locked = true;
      this.candPeriod = 480 / bpm;
      this.switchVotes = 0;
    } else {
      this.fixedClock.glideBpm(bpm);
    }
  }

  /** Double or halve the tempo (and, in auto mode, the search octave). */
  scaleBpm(factor: number): void {
    if (this.mode === 'auto') {
      this.settings.bpmLo = clamp(this.settings.bpmLo * factor, 30, 240);
      this.tracker.glideBpm(this.tracker.bpm * factor);
      this.switchVotes = 0;
    } else {
      this.fixedClock.glideBpm(this.fixedClock.bpm * factor);
    }
  }

  /** Declare that count 1 is (the beat nearest to) audio time t. Disables automatic count 1. */
  setCountOne(t: number): void {
    const c = this.clock;
    const cb = this.settings.cycleBeats;
    const cur = c.cycleBeatsAt(t);
    const target = this.mode === 'manual' ? cur : Math.round(cur);
    let shift = -(((target % cb) + cb) % cb);
    if (shift < -cb / 2) shift += cb;
    c.glideOffset(c.offset + shift);
    if (this.mode === 'auto') this.userDownbeat = true;
  }

  /** Shift which part of the cycle is shown at the top, in beats. */
  nudge(beats: number): void {
    const c = this.clock;
    c.glideOffset((c.offsetTarget ?? c.offset) + beats);
    if (this.mode === 'auto' && Math.abs(beats - Math.round(beats)) > 1e-6) this.userDownbeat = true;
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
    this.renumber(() => c.anchor(last, Math.round(b), bpm));
    if (this.mode === 'auto') {
      this.settings.bpmLo = octaveLo(bpm, this.settings.bpmLo);
      this.locked = true;
      this.candPeriod = 480 / bpm;
      this.switchVotes = 0;
    }
  }

  updateSettings(s: Partial<EngineSettings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...s };
    if (s.fmax !== undefined && this.specBinsFor(s.fmax) !== this.spec.freqBins) {
      this.spec = new FoldedSpectrogram(this.angleBins, this.specBinsFor(s.fmax));
      this.phosphor = new PhosphorScreen(this.angleBins, this.spec.freqBins);
      this.lastRebuild = -Infinity;
    }
    if (s.bpmLo !== undefined && s.bpmLo !== prev.bpmLo && this.mode === 'auto') {
      this.locked = false;
      this.candPeriod = 0;
    }
    if (s.autoDownbeat === true && !prev.autoDownbeat) this.userDownbeat = false;
    if (this.settings.cycleBeats !== prev.cycleBeats) this.phosphor.clear();
    this.lastRebuild = -Infinity;
  }

  // ---------------------------------------------------------------- input

  /** Feed mono samples whose first sample has absolute frame index `startFrame`. */
  push(startFrame: number, samples: Float32Array): void {
    const t0 = nowMs();
    let src = samples;
    if (this.head < 0) {
      this.head = startFrame;
      this.hopEnd = startFrame + this.features.n;
      this.specEnd = startFrame + this.specN;
    } else if (startFrame > this.head) {
      const gap = startFrame - this.head;
      if (gap > RING / 2) {
        this.discontinuity();
        this.head = startFrame;
        this.hopEnd = startFrame + this.features.n;
        this.specEnd = startFrame + this.specN;
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
    while (this.specEnd <= this.head) {
      this.processSpecFrame(this.specEnd);
      this.specEnd += this.specHop;
    }
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
    if (this.mode === 'auto') this.locked = false;
    this.candPeriod = 0;
    this.resetAccumulators();
  }

  /** Clear the tape (accumulated onsets and spectra). */
  resetAccumulators(): void {
    this.onsetHist = [];
    this.frames.clear();
    this.spec.clear();
    this.phosphor.clear();
    this.lastRebuild = -Infinity;
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

    this.rms += (f.rms - this.rms) * 0.1;
    for (let b = 0; b < N_BANDS; b++) this.bandEnergy[b] += (f.energy[b] - this.bandEnergy[b]) * 0.1;

    let all = 0;
    for (let b = 0; b < N_BANDS; b++) all += f.flux[b];

    for (let ch = 0; ch < N_CHANNELS; ch++) {
      const o = this.onsetDetectors[ch].push(ch === CHANNEL_ALL ? all : f.flux[ch], t, dt);
      if (o) {
        this.onsetCounts[ch]++;
        this.onsetHist.push({ time: o.time, beats: this.clock.beatsAt(o.time) - this.beatsBias, channel: ch, strength: o.strength });
        if (this.pendingOnsets.length < 256) this.pendingOnsets.push({ time: o.time, channel: ch, strength: o.strength, phase: frac(this.clock.cycleBeatsAt(o.time) / this.settings.cycleBeats) });
      }
    }
    if (this.onsetHist.length > 4000 || (this.onsetHist.length && t - this.onsetHist[0].time > MAX_HISTORY)) {
      const cut = t - MAX_HISTORY;
      let i = 0;
      while (i < this.onsetHist.length && this.onsetHist[i].time < cut) i++;
      if (this.onsetHist.length - i > 4000) i = this.onsetHist.length - 4000;
      this.onsetHist.splice(0, i);
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

  private processSpecFrame(end: number): void {
    const N = this.specN;
    const s0 = end - N;
    const re = this.specRe;
    const im = this.specIm;
    let ms = 0;
    for (let i = 0; i < N; i++) {
      const x = this.ring[(s0 + i) & (RING - 1)];
      ms += x * x;
      re[i] = x * this.specWin[i] * this.specNorm;
      im[i] = 0;
    }
    const tc = (s0 + N / 2) / this.sr;
    const recorded = this.clock.beatsAt(tc) - this.beatsBias;
    const silent = ms / N < SILENCE_MS;
    // The phosphor keeps fading in silence (the sweep goes on); the tape does not record it.
    if (silent) {
      this.phosphor.write(null, null, this.phosphorParams(recorded));
      return;
    }
    this.specFFT.forward(re, im);
    this.phosphor.write(re, im, this.phosphorParams(recorded));
    const slot = this.frames.push(tc, re, im, recorded);
    // Incremental fold under the current clock; full refolds happen at display time.
    if (this.settings.specRender === 'tape') this.spec.addSlot(this.frames, slot, this.foldParams());
  }

  private phosphorParams(recordedBeats: number) {
    return {
      phase: frac(recordedBeats / this.settings.cycleBeats),
      cycleDur: this.cycleDur(),
      frameStep: this.specHop / this.sr,
      memoryCycles: this.settings.memoryCycles,
      dbRange: this.settings.dbRange,
      fftSize: this.specN,
      sampleRate: this.sr,
    };
  }

  private foldParams() {
    return {
      phaseOf: this.phaseOf,
      cycleDur: this.cycleDur(),
      now: this.now,
      memoryCycles: this.settings.memoryCycles,
      fftSize: this.specN,
      sampleRate: this.sr,
    };
  }

  private envLinear(): Float32Array {
    const out = new Float32Array(this.envCount);
    const start = (this.envPos - this.envCount + this.envLen) % this.envLen;
    for (let i = 0; i < this.envCount; i++) out[i] = this.env[(start + i) % this.envLen];
    return out;
  }

  // ---------------------------------------------------------------- tempo & phase

  /** Reference cycle length for window sizes: the locked tempo, or the octave centre. */
  private refCycle(): number {
    return this.locked ? 480 / this.tracker.bpm : 480 / (1.5 * this.settings.bpmLo);
  }

  private foldOpt(depthCycles: number): FoldOptions {
    return { bins: FOLD_BINS, tau: clamp(depthCycles * this.refCycle(), 2.5, 16) };
  }

  /**
   * Hypotheses are ranked on a SHORT window (2 cycles) so that a real tempo
   * change shows up quickly; the winner is then refined on the adaptive DEEP
   * window, which is precise while the rhythm is stable.
   */
  private searchTempo(env: Float32Array): CycleSearch {
    const lo = this.settings.bpmLo;
    // The octave is half-open [lo, 2 lo): its upper edge is excluded (e.g. 120 when searching 60..120,
    // which would be the tresillo reading of 180). The grid extends 3 % beyond both edges so that
    // peaks near an edge are found as real peaks, then out-of-octave candidates are dropped.
    const inOctave = (bpm: number) => bpm >= lo * 0.995 && bpm < 2 * lo * 0.995;
    const Cmin = 480 / (2 * lo);
    const Cmax = 480 / lo;
    const tEnd = this.envEndTime;
    const rank = this.foldOpt(RANK_DEPTH);
    const coarse = searchCycle(env, this.envRate, tEnd, Cmin / 1.03, Cmax * 1.03, rank, 0.006);
    const inRange = coarse.candidates.filter((c) => inOctave(c.bpm));
    const seeds = inRange.slice(0, 3).map((c) => c.period);
    if (this.locked) seeds.push(480 / this.tracker.bpm);
    const refined = seeds
      .map((C) => searchCycle(env, this.envRate, tEnd, C * 0.985, C * 1.015, rank, 0.0008).best)
      .filter((c): c is NonNullable<typeof c> => !!c && inOctave(c.bpm));
    const all = [...refined, ...inRange];
    all.sort((a, b) => b.sharpness - a.sharpness);
    const distinct: typeof all = [];
    for (const p of all) if (distinct.every((q) => Math.abs(p.period / q.period - 1) > 0.03)) distinct.push(p);
    let best = distinct[0] ?? null;
    const margin = best && distinct[1] ? best.sharpness / Math.max(1e-9, distinct[1].sharpness) : best ? Infinity : 0;
    if (best) {
      // Precise period and sharpness from the deep window.
      const deep = searchCycle(env, this.envRate, tEnd, best.period * 0.99, best.period * 1.01, this.foldOpt(this.depthCycles), 0.0004).best;
      if (deep && Math.abs(deep.period / best.period - 1) < 0.008) best = deep;
      // Unbiased precise period from the onset times themselves (Z²ₙ, no binning ripple).
      const precise = this.refineWithOnsets(best.period);
      if (precise !== null && Math.abs(precise / best.period - 1) < 0.004) best = { ...best, period: precise, bpm: 480 / precise };
      distinct[0] = best;
    }
    return {
      best,
      candidates: distinct.slice(0, 6),
      floor: coarse.floor,
      contrast: best ? best.sharpness / coarse.floor : 0,
      margin,
    };
  }

  /** Z²ₙ refinement of the cycle period on recent onsets (all-band channel), deep-window weights. */
  private refineWithOnsets(C0: number): number | null {
    const tau = this.foldOpt(this.depthCycles).tau;
    const tEnd = this.envEndTime;
    const times: number[] = [];
    const weights: number[] = [];
    for (let i = this.onsetHist.length - 1; i >= 0; i--) {
      const o = this.onsetHist[i];
      const age = tEnd - o.time;
      if (age > 4 * tau) break;
      if (o.channel !== CHANNEL_ALL || age < 0) continue;
      times.push(o.time - tEnd); // relative times keep the phase factors well conditioned
      weights.push(Math.min(o.strength, 4) * Math.exp(-age / tau));
    }
    return refinePeriodByOnsets(times, weights, C0, 0.006, 0.0002, 16);
  }

  /**
   * Sub-bin phase refinement from the onset times. The folded profile has
   * ~40 ms bins, so its peak is quantised; the circular mean of onset times on
   * the eighth-note grid (2nd harmonic of the beat) is not. Offbeat ("&")
   * onsets fall on the same grid and reinforce it, so the coarse beat/& decision
   * from the template is kept and only the fine offset (< 1/4 beat) is taken.
   */
  private precisePhaseShift(tBeat: number, beat: number): number {
    const tau = this.foldOpt(Math.min(this.depthCycles, PHASE_DEPTH)).tau;
    const tEnd = this.envEndTime;
    let re = 0;
    let im = 0;
    let sw = 0;
    const w0 = (2 * Math.PI * 2) / beat;
    for (let i = this.onsetHist.length - 1; i >= 0; i--) {
      const o = this.onsetHist[i];
      const age = tEnd - o.time;
      if (age > 4 * tau) break;
      if (o.channel !== CHANNEL_ALL || age < 0) continue;
      const w = Math.min(o.strength, 4) * Math.exp(-age / tau);
      const a = w0 * (o.time - ONSET_LAG - tBeat);
      re += w * Math.cos(a);
      im += w * Math.sin(a);
      sw += w;
    }
    if (sw <= 0 || Math.hypot(re, im) / sw < 0.3) return 0; // no consistent eighth grid: keep the coarse phase
    const shift = (Math.atan2(im, re) / w0); // within ±1/4 beat
    return Math.abs(shift) < beat / 4 ? shift : 0;
  }

  private updateTempo(t: number): void {
    if (this.envCount < this.envRate * 3) return;
    const env = this.envLinear();
    const s = this.searchTempo(env);
    this.lastSearch = s;
    const conf = confidenceOf(s);
    const tr = this.tracker;

    if (!s.best || conf.level === 'none') {
      if (++this.lowConf > 8) this.locked = false;
      this.updateReferenceError(t);
      return;
    }
    this.lowConf = 0;
    const best = s.best;

    if (!this.locked) {
      if (this.candPeriod > 0 && Math.abs(best.period / this.candPeriod - 1) < 0.015) this.candCount++;
      else {
        this.candPeriod = best.period;
        this.candCount = 1;
      }
      if (this.candCount >= 2) {
        tr.anchor(t, tr.beatsAt(t), best.bpm);
        this.locked = true;
        this.switchVotes = 0;
        this.depthCycles = RANK_DEPTH;
        this.updatePhase(env, true);
      } else this.depthCycles = RANK_DEPTH;
      this.updateReferenceError(t);
      return;
    }

    const Ccur = 480 / (tr.bpmTarget ?? tr.bpm);
    const rel = best.period / Ccur - 1;
    if (Math.abs(rel) < 0.03) {
      tr.glideBpm(tr.bpm + 0.35 * (best.bpm - tr.bpm));
      this.switchVotes = 0;
      // Stable rhythm: dig deeper (more precise tempo and phase).
      this.depthCycles = Math.min(DEPTH_MAX, this.depthCycles + DEPTH_STEP);
    } else {
      // A competing hypothesis: go shallow at once so the new tempo can show through.
      this.depthCycles = DEPTH_MIN;
      // A different hypothesis wins: accept it only if it persists, then glide (no jump, no reset).
      if (this.switchPeriod > 0 && Math.abs(best.period / this.switchPeriod - 1) < 0.015) this.switchVotes++;
      else {
        this.switchPeriod = best.period;
        this.switchVotes = 1;
      }
      if (this.switchVotes >= SWITCH_VOTES && conf.margin >= 1.15) {
        tr.glideBpm(best.bpm);
        this.switchVotes = 0;
        this.depthCycles = DEPTH_MIN;
      }
    }
    if (this.settings.autoPhase) this.updatePhase(env, false);
    this.updateReferenceError(t);
  }

  /**
   * Beat phase (and count 1) from the envelope folded at the tracker's cycle.
   * With the salsa template the whole cycle pattern decides the phase, which
   * resolves the beat vs "&" ambiguity that a beat comb cannot.
   */
  private updatePhase(env: Float32Array, hard: boolean): void {
    const tr = this.tracker;
    const C = 480 / tr.bpm;
    const tEnd = this.envEndTime;
    // Phase uses a window of at most 3 cycles: depth helps the tempo, but with any residual tempo
    // error a deep phase fold reports where the beats were seconds ago (a lag bias).
    const prof = fold(env, this.envRate, tEnd, C, this.foldOpt(Math.min(this.depthCycles, PHASE_DEPTH))).profile;
    const B = prof.length;
    const tmpl = this.templates[this.settings.clave];
    const corr = circularCorr(prof, tmpl);
    const rot = peakOf(corr);
    const perBeat = B / 8;
    const alt = Math.max(at(corr, rot + perBeat / 2), at(corr, rot - perBeat / 2));
    const tmplRatio = alt > 0 ? at(corr, rot) / alt : at(corr, rot) > 0 ? 3 : 0;
    // Pearson r between the folded profile and the template: is this rhythm salsa-like at all?
    // (Off-genre music, half-time counting or a single offbeat layer give a low r -> neutral comb.)
    let pm = 0;
    for (let i = 0; i < B; i++) pm += prof[i];
    pm /= B;
    let pn = 0;
    let tn = 0;
    for (let i = 0; i < B; i++) {
      pn += (prof[i] - pm) ** 2;
      tn += tmpl[i] ** 2;
    }
    this.templateR = pn > 0 && tn > 0 ? at(corr, rot) / Math.sqrt(pn * tn) : 0;
    let beatT: number;
    let tOne: number | null = null;
    if (tmplRatio > 1.05 && this.templateR >= TEMPLATE_MIN_R) {
      this.phaseMethod = 'template';
      this.phaseStrength = tmplRatio;
      tOne = (rot / B) * C;
      beatT = tOne;
    } else {
      const g = beatGrid(prof);
      this.phaseMethod = 'comb';
      this.phaseStrength = g.onOffRatio;
      beatT = g.offset * C;
    }
    // Bring the reference beat near "now" so the clock is evaluated where it matters.
    const nb = Math.round((tEnd - beatT) / (C / 8));
    const tBeat = beatT + nb * (C / 8) + this.precisePhaseShift(beatT + nb * (C / 8), C / 8);
    const b = tr.beatsAt(tBeat);
    const err = Math.round(b) - b;
    if (hard) {
      tr.anchor(tBeat, Math.round(b), tr.bpm);
      this.flipVotes = 0;
    } else if (Math.abs(err) > 0.25) {
      // Half-beat jump: only with clear and persistent evidence.
      if (this.phaseStrength >= FLIP_MARGIN && ++this.flipVotes >= FLIP_VOTES) {
        tr.setCorrection(err);
        this.flipVotes = 0;
      } else if (this.phaseStrength < FLIP_MARGIN) this.flipVotes = 0;
    } else {
      this.flipVotes = 0;
      tr.setCorrection(0.6 * err);
    }

    // Count 1 from the template (only when the template, not the comb, placed the phase).
    if (tOne !== null && this.settings.autoDownbeat && !this.userDownbeat && this.settings.cycleBeats === 8) {
      const nc = Math.round((tEnd - tOne) / C);
      const cbAtOne = tr.cycleBeatsAt(tOne + nc * C) + (tr.offsetTarget ?? tr.offset) - tr.offset;
      let k = Math.round(cbAtOne) % 8;
      if (k < 0) k += 8;
      if (k > 4) k -= 8;
      if (k !== 0) {
        if (k === this.downTarget) this.downVotes++;
        else {
          this.downTarget = k;
          this.downVotes = 1;
        }
        if (hard || this.downVotes >= DOWNBEAT_VOTES) {
          tr.glideOffset((tr.offsetTarget ?? tr.offset) - k);
          this.downVotes = 0;
        }
      } else this.downVotes = 0;
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

  // ---------------------------------------------------------------- accumulation

  private specBinsFor(fmax: number): number {
    return Math.min(this.frames?.bins ?? this.specN / 2, Math.ceil(fmax / (this.sr / this.specN)) + 1);
  }

  private resetOnsetDetectors(): void {
    const fr = this.sr / this.hop;
    this.onsetDetectors = [];
    for (let ch = 0; ch < N_CHANNELS; ch++) this.onsetDetectors.push(new OnsetDetector(ch, fr));
  }

  /** Cycles of data in the tape (for display). */
  private cyclesInTape(): number {
    const n = this.frames.size;
    return n ? Math.floor((n * this.specHop) / this.sr / this.cycleDur()) : 0;
  }

  // ---------------------------------------------------------------- output

  snapshot(withSpec = true): EngineSnapshot {
    const c = this.clock;
    const p = this.foldParams();
    const density = foldOnsets(this.onsetHist, N_CHANNELS, this.densityBins, p);
    let spec: Uint8Array | null = null;
    if (withSpec) {
      spec = new Uint8Array(this.angleBins * this.spec.freqBins);
      if (this.settings.specRender === 'phosphor') {
        // Recorded coordinates -> current clock (count 1 and clock switches rotate the screen).
        this.phosphor.render(this.settings.display, frac((this.beatsBias + c.offset) / this.settings.cycleBeats), spec);
      } else {
        // Refold the whole tape a few times per second: follows the clock smoothly.
        if (this.now - this.lastRebuild > 0.2) {
          this.spec.rebuild(this.frames, p);
          this.lastRebuild = this.now;
        }
        this.spec.render(this.settings.display, this.settings.dbRange, spec);
      }
    }
    const onsets = this.pendingOnsets;
    this.pendingOnsets = [];
    const conf = confidenceOf(this.locked ? this.lastSearch : null);
    const lastConf = confidenceOf(this.lastSearch);
    return {
      algorithm: ALGORITHM_VERSION,
      time: this.now,
      clock: { mode: this.mode, tRef: c.tRef, beatRef: c.beatRef, bpm: c.bpm, offset: c.offset, cycleBeats: this.settings.cycleBeats },
      tracker: {
        locked: this.locked,
        bpm: this.tracker.bpm,
        confidence: conf.value,
        level: this.locked ? conf.level : 'none',
        sharpness: lastConf.sharpness,
        margin: lastConf.margin,
        candidates: (this.lastSearch?.candidates ?? []).map((k) => ({ bpm: k.bpm, score: k.sharpness })),
        phaseStrength: this.phaseStrength,
        phaseMethod: this.phaseMethod,
        templateR: this.templateR,
        depthCycles: this.depthCycles,
        downbeat: !this.settings.autoDownbeat ? 'off' : this.userDownbeat ? 'user' : 'auto',
        refPhaseErrorMs: this.refPhaseErrorMs,
        refBpmError: this.refBpmError,
      },
      onsets,
      density,
      densityBins: this.densityBins,
      spec,
      specAngleBins: this.angleBins,
      specFreqBins: this.spec.freqBins,
      specBinHz: this.sr / this.specN,
      cycles: this.cyclesInTape(),
      stats: {
        rms: this.rms,
        bandEnergyDb: Array.from(this.bandEnergy, (e) => 10 * Math.log10(e + 1e-12)),
        onsetCounts: [...this.onsetCounts],
        hopsPerSec: this.envRate,
        msPerSecondOfAudio: this.workAudioS > 0 ? this.workMs / this.workAudioS : 0,
        samplesIn: this.samplesIn,
      },
    };
  }
}

/** Per-revisit retention for a memory of `n` cycles (kept for compatibility). */
export function memoryAlpha(n: number): number {
  return n <= 1 ? 0 : Math.exp(-1 / n);
}

/** Salsa skeleton template (conga tumbao + bass tumbao + bongo bell), zero-mean, per clave direction. */
function buildTemplate(clave: ClaveDirection, bins: number): Float32Array {
  const t = new Float32Array(bins);
  for (const id of ['conga-tumbao-basic', 'bass-tumbao', 'campana-bongo-bell']) {
    const p = getPattern(id);
    if (!p) continue;
    const prof = patternProfile(patternPhases(p, clave), bins, 1.0);
    const m = prof.reduce((a, b) => a + b, 0) / bins;
    let norm = 0;
    for (const v of prof) norm += (v - m) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < bins; i++) t[i] += (prof[i] - m) / norm;
  }
  return t;
}

/** corr[r] = Σ_i (profile[i + r] - mean) * tmpl[i] : template placed with its count 1 at bin r. */
function circularCorr(profile: Float32Array, tmpl: Float32Array): Float32Array {
  const n = profile.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (profile[(i + r) % n] - mean) * tmpl[i];
    out[r] = s;
  }
  return out;
}

function at(v: Float32Array, pos: number): number {
  const n = v.length;
  let x = pos % n;
  if (x < 0) x += n;
  const i = Math.floor(x);
  const f = x - i;
  return v[i] * (1 - f) + v[(i + 1) % n] * f;
}

function peakOf(v: Float32Array): number {
  const n = v.length;
  let b = 0;
  for (let i = 1; i < n; i++) if (v[i] > v[b]) b = i;
  const y0 = v[(b - 1 + n) % n];
  const y1 = v[b];
  const y2 = v[(b + 1) % n];
  const d = y0 - 2 * y1 + y2;
  return b + (d < 0 ? (0.5 * (y0 - y2)) / d : 0);
}

/** Lower bound of the tempo octave that contains bpm, preferring the current one. */
function octaveLo(bpm: number, current: number): number {
  if (bpm >= current && bpm < 2 * current) return current;
  return clamp(bpm / Math.SQRT2, 30, 240);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
