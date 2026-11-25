import { describe, expect, it } from 'vitest';
import { FoldedSpectrogram, FrameHistory, ageWeight, foldOnsets, type FoldParams } from '../src/accumulate/folded';
import { mulberry32 } from '../src/util/math';

const K = 8;
const params = (over: Partial<FoldParams>): FoldParams => ({
  phaseOf: (t) => (t / 2) % 1,
  cycleDur: 2,
  now: 100,
  memoryCycles: 8,
  fftSize: 16,
  sampleRate: 1000,
  ...over,
});

describe('FoldedSpectrogram (tape folded with the current clock)', () => {
  it('identical spectra at the same phase in every cycle are fully coherent', () => {
    const h = new FrameHistory(64, K);
    const re = Float32Array.from({ length: K }, (_, k) => 0.1 * (k + 1));
    const im = Float32Array.from({ length: K }, (_, k) => -0.05 * k);
    // Frames exactly at a cell centre (phase 0.25 of a 4-cell cycle) in 10 cycles.
    for (let c = 0; c < 10; c++) h.push(80 + c * 2 + 0.5, re, im);
    const fs = new FoldedSpectrogram(4, K);
    fs.rebuild(h, params({}));
    const out = new Uint8Array(4 * K);
    fs.render('coherence', 200, out);
    for (let k = 0; k < K; k++) expect(out[K + k]).toBe(255);
    expect(out[0]).toBe(0); // cell 0 never observed
  });

  it('random-phase spectra lose coherence but keep power', () => {
    const h = new FrameHistory(512, K);
    const rnd = mulberry32(3);
    const re = new Float32Array(K);
    const im = new Float32Array(K);
    for (let c = 0; c < 400; c++) {
      for (let k = 0; k < K; k++) {
        const ph = rnd() * 2 * Math.PI;
        re[k] = Math.cos(ph);
        im[k] = Math.sin(ph);
      }
      h.push(100 - c * 2, re, im);
    }
    const fs = new FoldedSpectrogram(1, K);
    fs.rebuild(h, params({ memoryCycles: 32 }));
    for (let k = 0; k < K; k++) {
      const p = fs.P[k] / fs.W[0];
      const c = (fs.Cr[k] ** 2 + fs.Ci[k] ** 2) / fs.W[0] ** 2;
      expect(p).toBeCloseTo(1, 5);
      expect(c / p).toBeLessThan(0.1);
    }
  });

  it('compensates the frame-to-cell time offset with a linear phase ramp', () => {
    // A stationary component observed by frames that sit off the cell centre by
    // different amounts: after compensation the frames add up coherently.
    const N = 16;
    const sr = 1000;
    const h = new FrameHistory(64, K);
    const re = new Float32Array(K);
    const im = new Float32Array(K);
    for (let c = 0; c < 6; c++) {
      const off = ((c % 3) - 1) * 0.002; // -2, 0, +2 ms from the cell centre
      const t = 80 + c * 2 + 0.5 + off;
      // x_frame[n] = x_cell[n + d] with d = off*sr samples, so X_frame[k] = X_cell[k] e^{+j2πkd/N}.
      for (let k = 0; k < K; k++) {
        const ph = (2 * Math.PI * k * off * sr) / N;
        re[k] = Math.cos(ph);
        im[k] = Math.sin(ph);
      }
      h.push(t, re, im);
    }
    const fs = new FoldedSpectrogram(4, K);
    fs.rebuild(h, params({ fftSize: N, sampleRate: sr, memoryCycles: 32 }));
    for (let k = 0; k < K; k++) {
      const c = fs.Cr[K + k] ** 2 + fs.Ci[K + k] ** 2;
      const p = fs.P[K + k] * fs.W[1];
      expect(c / p).toBeGreaterThan(0.98);
    }
  });

  it('a tempo change re-folds the existing tape instead of erasing it', () => {
    const h = new FrameHistory(64, 1);
    // One frame per cycle at phase 0.5 under a 2-second cycle.
    for (let c = 0; c < 8; c++) h.push(84 + c * 2 + 1, [1], [0]);
    const fs = new FoldedSpectrogram(8, 1);
    fs.rebuild(h, params({}));
    expect(fs.W[4]).toBeGreaterThan(0);
    // Same tape, slightly different tempo: still all there (smeared), nothing lost.
    fs.rebuild(h, params({ phaseOf: (t) => (t / 2.02) % 1, cycleDur: 2.02 }));
    let total = 0;
    for (let a = 0; a < 8; a++) total += fs.W[a];
    expect(total).toBeGreaterThan(1);
  });
});

describe('ageing and onset folding', () => {
  it('weights age exponentially in cycles; instant mode keeps exactly one cycle', () => {
    expect(ageWeight(16, { cycleDur: 2, memoryCycles: 8 })).toBeCloseTo(Math.exp(-1), 9);
    expect(ageWeight(1.9, { cycleDur: 2, memoryCycles: 1 })).toBe(1);
    expect(ageWeight(2.1, { cycleDur: 2, memoryCycles: 1 })).toBe(0);
  });

  it('splits an onset between neighbouring bins (no hard quantisation)', () => {
    const d = foldOnsets([{ time: 100, beats: 0, channel: 0, strength: 1 }], 1, 10, { phaseOf: () => 0.125, cycleDur: 2, now: 100, memoryCycles: 8 });
    expect(d[1]).toBeCloseTo(0.75, 9);
    expect(d[2]).toBeCloseTo(0.25, 9);
  });
});

import { PhosphorScreen } from '../src/accumulate/phosphor';

describe('PhosphorScreen (CRT-like persistence)', () => {
  const A = 16;
  const cycleDur = 2;
  const frameStep = cycleDur / A; // one frame per cell per sweep
  const wp = (phase: number, N: number) => ({ phase, cycleDur, frameStep, memoryCycles: N, dbRange: 60, fftSize: 16, sampleRate: 1000 });
  // "Bass": loud at bin 1; "claves": quieter at bin 6, bin 1 near silent.
  const bass = { re: Float32Array.from({ length: K }, (_, k) => (k === 1 ? 1 : 1e-4)), im: new Float32Array(K) };
  const clave = { re: Float32Array.from({ length: K }, (_, k) => (k === 6 ? 0.3 : 1e-4)), im: new Float32Array(K) };
  const sweep = (ps: PhosphorScreen, f: { re: Float32Array; im: Float32Array }, N: number) => {
    for (let a = 0; a < A; a++) ps.write(f.re, f.im, wp(a / A, N));
  };

  it('moves each cell by 1/N of the difference per sweep and forgets a stopped instrument', () => {
    const N = 16;
    const ps = new PhosphorScreen(A, K);
    for (let c = 0; c < 60; c++) sweep(ps, bass, N);
    const lit = ps.L[3 * K + 1];
    expect(lit).toBeGreaterThan(0.95);
    sweep(ps, clave, N);
    // One sweep: v <- v + (x - v)/N.
    const x = ps.L[3 * K + 1];
    expect(Math.abs(lit - x - (lit - 0) / N)).toBeLessThan(0.02);
    for (let c = 1; c < 50; c++) sweep(ps, clave, N);
    // After 50 sweeps of claves only: (15/16)^50 ≈ 4 % of the bass brightness.
    expect(ps.L[3 * K + 1]).toBeLessThan(0.06 * lit);
    expect(ps.L[3 * K + 6]).toBeGreaterThan(0.9);
  });

  it('the dB tape keeps the same stopped bass visible (why the phosphor exists)', () => {
    const h = new FrameHistory(4096, K);
    for (let c = 0; c < 80; c++) for (let a = 0; a < A; a++) h.push(c * cycleDur + (a + 0.5) * frameStep, c < 30 ? bass.re : clave.re, bass.im);
    const fs = new FoldedSpectrogram(A, K);
    fs.rebuild(h, params({ now: 80 * cycleDur, memoryCycles: 16, cycleDur, phaseOf: (t) => (t / cycleDur) % 1 }));
    const out = new Uint8Array(A * K);
    fs.render('power', 60, out);
    expect(out[3 * K + 1]).toBeGreaterThan(128); // still bright after 50 cycles
  });

  it('identical frames are fully coherent; random phases are not', () => {
    const ps = new PhosphorScreen(A, K);
    for (let c = 0; c < 40; c++) sweep(ps, { re: clave.re, im: Float32Array.from({ length: K }, (_, k) => (k === 6 ? 0.2 : 0)) }, 8);
    const out = new Uint8Array(A * K);
    ps.render('coherence', 0, out);
    expect(out[5 * K + 6]).toBe(255);
    const rnd = mulberry32(5);
    const ps2 = new PhosphorScreen(A, K);
    const re = new Float32Array(K);
    const im = new Float32Array(K);
    for (let c = 0; c < 200; c++)
      for (let a = 0; a < A; a++) {
        for (let k = 0; k < K; k++) {
          const ph = rnd() * 2 * Math.PI;
          re[k] = Math.cos(ph);
          im[k] = Math.sin(ph);
        }
        ps2.write(re, im, wp(a / A, 8));
      }
    ps2.render('coherence', 0, out);
    expect(out[5 * K + 6]).toBeLessThan(1 + 254 * 0.4);
  });

  it('silence fades the screen; rotation moves the image, not the data', () => {
    const ps = new PhosphorScreen(A, K);
    ps.write(bass.re, bass.im, wp(2 / A, 1));
    const out = new Uint8Array(A * K);
    ps.render('power', 0.25, out); // rotate a quarter cycle = 4 cells
    expect(out[6 * K + 1]).toBe(255);
    expect(out[2 * K + 1]).toBe(0);
    for (let c = 0; c < 64; c++) ps.write(null, null, wp(2 / A, 8));
    expect(ps.L[2 * K + 1]).toBeLessThan(0.05);
  });
});
