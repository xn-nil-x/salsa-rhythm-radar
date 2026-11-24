/**
 * End-to-end: synthetic audio with known tempo/phase -> AnalysisEngine.
 * Metrics follow the task spec: BPM error, phase error in ms, time to lock.
 */
import { describe, expect, it } from 'vitest';
import { AnalysisEngine, CHANNEL_ALL } from '../src/audio/analysis-engine';
import { renderRhythm, type SynthLayer } from '../src/audio/synth';
import { getPattern } from '../src/rhythm/library';
import { wrapHalf } from '../src/util/math';

const SR = 44100;
const layer = (id: string, gain = 1): SynthLayer => ({ pattern: getPattern(id)!, gain });
const FULL = [
  layer('son-clave-3-2'),
  layer('conga-tumbao-basic'),
  layer('bass-tumbao'),
  layer('campana-bongo-bell', 0.7),
  layer('piano-montuno-generic', 0.6),
];

interface RunResult {
  engine: AnalysisEngine;
  bpm: number;
  start: number;
  lockTime: number | null;
  phaseErrMs: number[];
}

function run(opts: {
  bpm: number;
  seconds: number;
  layers?: SynthLayer[];
  bpmLo?: number;
  jitterMs?: number;
  dropProb?: number;
  noiseDb?: number;
  seed?: number;
}): RunResult {
  const start = 0.37;
  const r = renderRhythm({
    sampleRate: SR,
    bpm: opts.bpm,
    cycles: Math.ceil((opts.seconds * opts.bpm) / 60 / 8),
    clave: '3-2',
    layers: opts.layers ?? FULL,
    startOffset: start,
    jitterMs: opts.jitterMs,
    dropProb: opts.dropProb,
    noiseDb: opts.noiseDb,
    seed: opts.seed,
  });
  const engine = new AnalysisEngine(SR, { bpmLo: opts.bpmLo ?? 120 });
  let lockTime: number | null = null;
  const phaseErrMs: number[] = [];
  const block = 1024;
  let nextCheck = 1;
  for (let i = 0; i + block <= r.samples.length; i += block) {
    engine.push(i, r.samples.subarray(i, i + block));
    const t = (i + block) / SR;
    if (lockTime === null && engine.isLocked) lockTime = t;
    if (t >= nextCheck) {
      nextCheck += 0.5;
      if (engine.isLocked) {
        const truthBeats = ((t - start) * r.bpm) / 60;
        const d = wrapHalf(engine.tracker.beatsAt(t) - truthBeats);
        phaseErrMs.push((d * 60000) / r.bpm);
      }
    }
  }
  return { engine, bpm: r.bpm, start, lockTime, phaseErrMs };
}

const tail = (a: number[], n: number) => a.slice(Math.max(0, a.length - n));
const maxAbs = (a: number[]) => Math.max(...a.map(Math.abs));

describe('AnalysisEngine on synthetic salsa', () => {
  for (const bpm of [160, 180, 200]) {
    it(`locks to ${bpm} BPM and tracks phase`, () => {
      const res = run({ bpm, seconds: 16 });
      expect(res.lockTime, 'never locked').not.toBeNull();
      expect(res.lockTime!).toBeLessThan(8);
      expect(Math.abs(res.engine.tracker.bpm - res.bpm)).toBeLessThan(1);
      expect(maxAbs(tail(res.phaseErrMs, 8))).toBeLessThan(25);
    });
  }

  it('handles 90 vs 180: the search octave decides', () => {
    const half = run({ bpm: 180, seconds: 14, bpmLo: 60 });
    expect(Math.abs(half.engine.tracker.bpm - 90)).toBeLessThan(1);
  });

  it('survives timing jitter, dropped strokes and noise', () => {
    const res = run({ bpm: 180, seconds: 18, jitterMs: 8, dropProb: 0.15, noiseDb: -30, seed: 11 });
    expect(res.lockTime).not.toBeNull();
    expect(Math.abs(res.engine.tracker.bpm - res.bpm)).toBeLessThan(1.5);
    expect(maxAbs(tail(res.phaseErrMs, 8))).toBeLessThan(40);
  });

  it('accumulates observed onsets where the clave plays (reference clock)', () => {
    const bpm = 180;
    const start = 0.37;
    const r = renderRhythm({ sampleRate: SR, bpm, cycles: 6, clave: '3-2', layers: [layer('son-clave-3-2')], startOffset: start });
    const engine = new AnalysisEngine(SR, { memoryCycles: 8 });
    engine.setReference(start, 0, r.bpm);
    for (let i = 0; i + 512 <= r.samples.length; i += 512) engine.push(i, r.samples.subarray(i, i + 512));
    const snap = engine.snapshot(false);
    const bins = snap.densityBins;
    const dens = snap.density.subarray(CHANNEL_ALL * bins, (CHANNEL_ALL + 1) * bins);
    const max = Math.max(...dens);
    const peaks: number[] = [];
    for (let b = 0; b < bins; b++) {
      const prev = dens[(b - 1 + bins) % bins];
      const next = dens[(b + 1) % bins];
      if (dens[b] > 0.3 * max && dens[b] >= prev && dens[b] > next) peaks.push((b / bins) * 8 + 1);
    }
    const expected = [1, 2.5, 4, 6, 7];
    expect(peaks.length).toBe(expected.length);
    peaks.forEach((p, i) => expect(Math.abs(p - expected[i])).toBeLessThan(0.15));
  });

  it('polar spectrogram: a looped (identical) signal is coherent, jittered one much less', () => {
    const coherenceOf = (jitterMs: number) => {
      const bpm = 180;
      const start = 0.2;
      const r = renderRhythm({
        sampleRate: SR, bpm, cycles: 10, clave: '3-2', layers: [layer('son-clave-3-2'), layer('conga-tumbao-basic')],
        startOffset: start, jitterMs, seed: 5,
      });
      const engine = new AnalysisEngine(SR, { memoryCycles: 16, display: 'power', dbRange: 30 });
      engine.setReference(start, 0, r.bpm);
      for (let i = 0; i + 1024 <= r.samples.length; i += 1024) engine.push(i, r.samples.subarray(i, i + 1024));
      const power = engine.snapshot(true).spec!;
      engine.updateSettings({ display: 'coherence' });
      const snap = engine.snapshot(true);
      const coh = snap.spec!;
      // Average coherence over energetic cells only (within ~8 dB of the strongest).
      let sum = 0;
      let n = 0;
      for (let i = 0; i < power.length; i++) {
        if (power[i] > 185) {
          sum += (coh[i] - 1) / 254;
          n++;
        }
      }
      return { mean: n ? sum / n : 0, cycles: snap.cycles, cells: n };
    };
    const clean = coherenceOf(0);
    const jittered = coherenceOf(12);
    expect(clean.cycles).toBeGreaterThanOrEqual(8);
    expect(clean.mean).toBeGreaterThan(0.9);
    expect(jittered.mean).toBeLessThan(clean.mean - 0.2);
  });
});
