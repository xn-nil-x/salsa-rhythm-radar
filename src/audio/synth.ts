/**
 * Deterministic synthetic rhythm renderer (pure TS, no Web Audio).
 *
 * Used by Demo mode (rendered buffer is looped by an AudioBufferSourceNode)
 * and by tests, so the ground truth — exact tempo, phase, event times — is
 * known. Voices are crude physical caricatures: they are test signals with
 * the right spectral regions and envelopes, not instrument models.
 */
import { mulberry32 } from '../util/math';
import { patternPhases } from '../rhythm/library';
import type { ClaveDirection, InstrumentId, RhythmPattern } from '../rhythm/types';

export interface SynthLayer {
  pattern: RhythmPattern;
  gain: number;
}

export interface RenderOptions {
  sampleRate: number;
  bpm: number;
  cycles: number;
  cycleBeats?: number;
  clave: ClaveDirection;
  layers: SynthLayer[];
  /** Gaussian-ish timing jitter, ms (standard deviation). */
  jitterMs?: number;
  /** Probability of dropping a stroke. */
  dropProb?: number;
  /** White noise level, dBFS RMS. */
  noiseDb?: number;
  seed?: number;
  /** Wrap tails into the beginning so the buffer loops seamlessly. */
  loop?: boolean;
  /** Time of count 1 of the first cycle inside the buffer, seconds. */
  startOffset?: number;
}

export interface GroundTruthEvent {
  time: number;
  patternId: string;
  instrument: InstrumentId;
  phase: number;
  cycle: number;
  intensity: number;
}

export interface RenderResult {
  samples: Float32Array;
  sampleRate: number;
  /** Exact tempo of the rendered buffer (cycle length is an integer number of samples). */
  bpm: number;
  cycleSamples: number;
  events: GroundTruthEvent[];
}

const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

type Voice = (out: Float32Array, start: number, sr: number, amp: number, stroke: string, durS: number, pitch: number | number[] | undefined, rnd: () => number) => void;

function addSamples(out: Float32Array, start: number, len: number, wrap: boolean, f: (i: number) => number): void {
  const n = out.length;
  for (let i = 0; i < len; i++) {
    let j = start + i;
    if (j >= n) {
      if (!wrap) break;
      j %= n;
    }
    if (j < 0) continue;
    out[j] += f(i);
  }
}

function makeVoices(wrap: boolean): Record<InstrumentId, Voice> {
  const tone = (out: Float32Array, start: number, sr: number, amp: number, freqs: number[], weights: number[], tau: number, lenS: number, attack = 0.002) => {
    const len = Math.round(lenS * sr);
    const w = freqs.map((f) => (2 * Math.PI * f) / sr);
    addSamples(out, start, len, wrap, (i) => {
      const t = i / sr;
      const env = Math.min(1, t / attack) * Math.exp(-t / tau);
      let s = 0;
      for (let k = 0; k < w.length; k++) s += weights[k] * Math.sin(w[k] * i);
      return amp * env * s;
    });
  };
  const noise = (out: Float32Array, start: number, sr: number, amp: number, tau: number, lenS: number, hp: number, rnd: () => number, am = 0) => {
    const len = Math.round(lenS * sr);
    let prev = 0;
    addSamples(out, start, len, wrap, (i) => {
      const t = i / sr;
      const x = rnd() * 2 - 1;
      const y = x - hp * prev; // crude high-pass / brightening
      prev = x;
      const mod = am > 0 ? 0.55 + 0.45 * Math.sin(2 * Math.PI * am * t) : 1;
      return amp * Math.min(1, t / 0.001) * Math.exp(-t / tau) * y * mod;
    });
  };

  return {
    clave: (o, s, sr, a) => tone(o, s, sr, a, [2500, 3900], [1, 0.25], 0.02, 0.12, 0.0005),
    conga: (o, s, sr, a, stroke, _d, _p, rnd) => {
      if (stroke === 'slap') {
        noise(o, s, sr, a * 0.7, 0.012, 0.06, 0.9, rnd);
        tone(o, s, sr, a * 0.5, [420, 690], [1, 0.4], 0.03, 0.1);
      } else if (stroke === 'open') {
        tone(o, s, sr, a, [330, 545], [1, 0.25], 0.12, 0.4);
      } else {
        tone(o, s, sr, a * 0.6, [210], [1], 0.025, 0.08);
      }
    },
    bass: (o, s, sr, a, _st, durS, pitch) => {
      const f = midiHz(typeof pitch === 'number' ? pitch : 36);
      tone(o, s, sr, a, [f, 2 * f, 3 * f], [1, 0.35, 0.12], 0.45, Math.max(0.15, durS), 0.006);
    },
    campana: (o, s, sr, a, stroke) => {
      const base = stroke === 'open' ? 1 : 1.07;
      tone(o, s, sr, a, [610 * base, 905 * base, 1730 * base], [1, 0.7, 0.35], stroke === 'open' ? 0.18 : 0.05, 0.5, 0.0008);
    },
    bongo: (o, s, sr, a, stroke) => {
      if (stroke === 'open-hembra') tone(o, s, sr, a, [520, 870], [1, 0.3], 0.07, 0.25);
      else tone(o, s, sr, a, [stroke === 'thumb' ? 760 : 980, 1650], [1, 0.3], 0.025, 0.1);
    },
    timbales: (o, s, sr, a, _st, _d, _p, rnd) => {
      noise(o, s, sr, a * 0.5, 0.01, 0.05, 0.95, rnd);
      tone(o, s, sr, a * 0.6, [1850, 3100], [1, 0.5], 0.02, 0.08, 0.0004);
    },
    guiro: (o, s, sr, a, _st, durS, _p, rnd) => noise(o, s, sr, a * 0.5, Math.max(0.03, durS * 0.7), Math.max(0.05, durS), 0.97, rnd, 70),
    maracas: (o, s, sr, a, _st, _d, _p, rnd) => noise(o, s, sr, a * 0.35, 0.02, 0.07, 0.98, rnd),
    piano: (o, s, sr, a, _st, durS, pitch) => {
      const notes = Array.isArray(pitch) ? pitch : [typeof pitch === 'number' ? pitch : 60];
      for (const m of notes) {
        const f = midiHz(m);
        tone(o, s, sr, a / notes.length, [f, 2 * f, 3 * f], [1, 0.45, 0.2], 0.35, Math.max(0.12, durS + 0.05), 0.003);
      }
    },
  };
}

/** Box-Muller from a uniform generator. */
function gauss(rnd: () => number): number {
  const u = Math.max(1e-12, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export function renderRhythm(opt: RenderOptions): RenderResult {
  const sr = opt.sampleRate;
  const cycleBeats = opt.cycleBeats ?? 8;
  const cycleSamples = Math.round(((cycleBeats * 60) / opt.bpm) * sr);
  const bpm = (cycleBeats * 60 * sr) / cycleSamples;
  const startSamples = Math.round((opt.startOffset ?? 0) * sr);
  const total = startSamples + cycleSamples * opt.cycles + (opt.loop ? 0 : Math.round(sr * 0.6));
  const out = new Float32Array(total);
  const voices = makeVoices(!!opt.loop);
  const rnd = mulberry32(opt.seed ?? 1);
  const events: GroundTruthEvent[] = [];
  const cycleDur = cycleSamples / sr;

  for (let c = 0; c < opt.cycles; c++) {
    for (const layer of opt.layers) {
      const p = layer.pattern;
      const phases = patternPhases(p, opt.clave);
      for (const e of phases) {
        if (opt.dropProb && rnd() < opt.dropProb) continue;
        const jitter = opt.jitterMs ? (gauss(rnd) * opt.jitterMs) / 1000 : 0;
        const time = (opt.startOffset ?? 0) + (c + e.phase) * cycleDur + jitter;
        const start = Math.round(time * sr);
        const durS = e.extent * cycleDur;
        const src = p.events.find((x) => Math.abs(((x.step / p.grid + (p.clave && p.clave !== opt.clave ? 0.5 : 0)) % 1) - e.phase) < 1e-9);
        voices[p.instrument](out, start, sr, 0.35 * layer.gain * e.intensity, e.stroke, durS, src?.pitch, rnd);
        events.push({ time, patternId: p.id, instrument: p.instrument, phase: e.phase, cycle: c, intensity: e.intensity });
      }
    }
  }

  if (opt.noiseDb !== undefined && opt.noiseDb > -150) {
    const a = Math.pow(10, opt.noiseDb / 20) * Math.sqrt(3);
    for (let i = 0; i < total; i++) out[i] += a * (rnd() * 2 - 1);
  }
  // Soft limiter keeps dense mixes in range without hard clipping.
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i]);
  events.sort((a, b) => a.time - b.time);
  return { samples: out, sampleRate: sr, bpm, cycleSamples, events };
}
