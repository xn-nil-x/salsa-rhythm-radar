import { describe, expect, it } from 'vitest';
import { PolarSpectrogram } from '../src/accumulate/polar-spectrogram';
import { EventAccumulator } from '../src/accumulate/event-accumulator';
import { mulberry32 } from '../src/util/math';

describe('PolarSpectrogram', () => {
  const K = 8;

  it('repeated identical spectra are fully coherent', () => {
    const ps = new PolarSpectrogram(4, K);
    const re = Float32Array.from({ length: K }, (_, k) => 0.1 * (k + 1));
    const im = Float32Array.from({ length: K }, (_, k) => -0.05 * k);
    for (let c = 0; c < 20; c++) ps.accumulate(1, re, im, 0.8, 0);
    const out = new Uint8Array(4 * K);
    ps.render('coherence', 0, 200, out);
    for (let k = 0; k < K; k++) expect(out[K + k]).toBe(255);
    expect(out[0]).toBe(0); // angle bin 0 never observed
  });

  it('random-phase spectra lose coherence but keep power', () => {
    const ps = new PolarSpectrogram(1, K);
    const rnd = mulberry32(3);
    const re = new Float32Array(K);
    const im = new Float32Array(K);
    for (let c = 0; c < 400; c++) {
      for (let k = 0; k < K; k++) {
        const ph = rnd() * 2 * Math.PI;
        re[k] = Math.cos(ph);
        im[k] = Math.sin(ph);
      }
      ps.accumulate(0, re, im, Math.exp(-1 / 32), 0);
    }
    for (let k = 0; k < K; k++) {
      const p = ps.power[k];
      const c = ps.cre[k] ** 2 + ps.cim[k] ** 2;
      expect(p).toBeCloseTo(1, 5);
      expect(c / p).toBeLessThan(0.25);
    }
  });

  it('compensates sub-sample frame offsets with a linear phase ramp', () => {
    // A frame that started `delta` samples early has X[k] e^{-j 2pi k delta/N}; the
    // accumulator must undo it when given phaseStep = -2 pi delta / N.
    const ps = new PolarSpectrogram(1, K);
    const N = 16;
    const re = new Float32Array(K);
    const im = new Float32Array(K);
    for (let c = 0; c < 10; c++) {
      const delta = (c % 3) * 0.3;
      for (let k = 0; k < K; k++) {
        const ph = (-2 * Math.PI * k * delta) / N;
        re[k] = Math.cos(ph);
        im[k] = Math.sin(ph);
      }
      ps.accumulate(0, re, im, 0.9, (-2 * Math.PI * delta) / N);
    }
    for (let k = 0; k < K; k++) {
      expect(ps.cre[k] ** 2 + ps.cim[k] ** 2).toBeCloseTo(ps.power[k], 6);
    }
  });

  it('instant mode keeps only the latest cycle', () => {
    const ps = new PolarSpectrogram(1, 1);
    ps.accumulate(0, [1], [0], 0, 0);
    ps.accumulate(0, [0.5], [0], 0, 0);
    expect(ps.power[0]).toBeCloseTo(0.25, 9);
  });

  it('rotates the phase axis', () => {
    const ps = new PolarSpectrogram(4, 1);
    ps.accumulate(1, [1], [0], 0, 0);
    ps.rotate(2);
    expect(ps.power[3]).toBe(1);
    expect(ps.power[1]).toBe(0);
  });
});

describe('EventAccumulator', () => {
  it('splits an onset between neighbouring bins (no hard quantisation)', () => {
    const acc = new EventAccumulator(1, 10);
    acc.add(0, 0.125, 1);
    expect(acc.density[1]).toBeCloseTo(0.75, 9);
    expect(acc.density[2]).toBeCloseTo(0.25, 9);
  });

  it('ages a bin only when the playhead sweeps over it', () => {
    const acc = new EventAccumulator(1, 4);
    acc.add(0, 0.5, 1); // bin 2
    acc.sweep(0.0, 0.5);
    acc.sweep(0.3, 0.5); // crosses bin 1 only
    expect(acc.density[2]).toBeCloseTo(1, 9);
    acc.sweep(0.6, 0.5); // crosses bin 2
    expect(acc.density[2]).toBeCloseTo(0.5, 9);
  });
});
