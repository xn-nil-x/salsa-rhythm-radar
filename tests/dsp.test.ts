import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft';
import { autocorr, estimateBeatPhase, estimateTempo } from '../src/dsp/tempo';
import { OnsetDetector } from '../src/dsp/onset';
import { Transport } from '../src/audio/transport';
import { mulberry32 } from '../src/util/math';

describe('FFT', () => {
  it('matches a naive DFT', () => {
    const n = 64;
    const rnd = mulberry32(7);
    const x = Array.from({ length: n }, () => rnd() * 2 - 1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        sr += x[t] * Math.cos((-2 * Math.PI * k * t) / n);
        si += x[t] * Math.sin((-2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(100)).toThrow();
  });
});

/** Onset envelope with unit pulses every beat (plus weaker off-beats). */
function pulseEnvelope(bpm: number, rate: number, seconds: number, firstBeat: number, seed = 1): Float32Array {
  const env = new Float32Array(Math.round(rate * seconds));
  const rnd = mulberry32(seed);
  for (let i = 0; i < env.length; i++) env[i] = 0.05 * rnd();
  const period = (60 / bpm) * rate;
  for (let b = 0; ; b++) {
    const pos = firstBeat * rate + b * period;
    if (pos >= env.length - 1) break;
    const i = Math.floor(pos);
    const f = pos - i;
    env[i] += 1 - f;
    env[i + 1] += f;
    const off = pos + period / 2;
    if (off < env.length - 1) env[Math.floor(off)] += 0.3;
  }
  return env;
}

describe('tempo estimation', () => {
  const rate = 44100 / 512;

  it('autocorrelation is normalised at lag 0', () => {
    const ac = autocorr(pulseEnvelope(120, rate, 6, 0.1), 50);
    expect(ac[0]).toBeCloseTo(1, 6);
  });

  for (const bpm of [92, 128, 150, 180, 205]) {
    it(`finds ${bpm} BPM within 0.5 BPM`, () => {
      const lo = bpm >= 120 ? 120 : 60;
      const est = estimateTempo(pulseEnvelope(bpm, rate, 8, 0.137), rate, lo, 2 * lo);
      expect(Math.abs(est.bpm - bpm)).toBeLessThan(0.5);
      expect(est.confidence).toBeGreaterThan(0.3);
    });
  }

  it('reports the octave the caller asked for (90 vs 180)', () => {
    const env = pulseEnvelope(90, rate, 8, 0.2);
    expect(Math.abs(estimateTempo(env, rate, 60, 120).bpm - 90)).toBeLessThan(0.5);
    // In the 120..240 octave the same signal reads as 180: the ambiguity is explicit.
    expect(Math.abs(estimateTempo(env, rate, 120, 240).bpm - 180)).toBeLessThan(1);
  });

  it('locates the beat phase', () => {
    const bpm = 150;
    const first = 0.123;
    const env = pulseEnvelope(bpm, rate, 6, first);
    const period = (60 / bpm) * rate;
    const { offset, strength } = estimateBeatPhase(env, period);
    const lastBeatPos = env.length - 1 - offset;
    const k = (lastBeatPos / rate - first) / (60 / bpm);
    expect(Math.abs(k - Math.round(k)) * (60 / bpm) * 1000).toBeLessThan(6);
    expect(strength).toBeGreaterThan(0.3);
  });
});

describe('onset detector', () => {
  it('fires once per isolated peak with sub-hop timing', () => {
    const rate = 100;
    const det = new OnsetDetector(0, rate);
    const found: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i / rate;
      const v = i % 50 === 25 ? 1 : i % 50 === 26 ? 0.5 : 0.01;
      const o = det.push(v, t, 1 / rate);
      if (o) found.push(o.time);
    }
    expect(found.length).toBe(6);
    expect(found[0]).toBeGreaterThan(0.25);
    expect(found[0]).toBeLessThan(0.26);
  });
});

describe('transport', () => {
  it('keeps phase continuous across tempo changes', () => {
    const tr = new Transport();
    tr.anchor(1, 0, 120);
    const before = tr.beatsAt(3);
    tr.setBpm(180, 3);
    expect(tr.beatsAt(3)).toBeCloseTo(before, 9);
    expect(tr.beatsAt(4) - tr.beatsAt(3)).toBeCloseTo(3, 9);
  });

  it('bleeds phase corrections at a bounded rate', () => {
    const tr = new Transport();
    tr.anchor(0, 0, 120);
    tr.slewRate = 0.5;
    tr.setCorrection(0.4);
    const dt = 0.01;
    let maxStep = 0;
    let prev = tr.beatsAt(0);
    for (let i = 1; i <= 200; i++) {
      const t = i * dt;
      tr.advance(t, dt);
      const b = tr.beatsAt(t);
      maxStep = Math.max(maxStep, b - prev - 2 * dt);
      prev = b;
    }
    expect(maxStep).toBeLessThanOrEqual(0.5 * dt + 1e-9);
    expect(tr.beatsAt(2)).toBeCloseTo(4.4, 6);
    expect(tr.pendingCorrection).toBe(0);
  });

  it('maps cycle beats back to time including the user offset', () => {
    const tr = new Transport();
    tr.anchor(2, 10, 150);
    tr.offset = 3;
    expect(tr.timeAtCycleBeats(tr.cycleBeatsAt(5.5))).toBeCloseTo(5.5, 9);
  });
});
