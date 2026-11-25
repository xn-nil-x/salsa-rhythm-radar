/**
 * Reproducible tracker benchmark on synthetic signals with known ground truth.
 *   npm run bench
 * Prints a Markdown table: lock time, BPM error, phase error (ms) after lock.
 */
import { AnalysisEngine, ALGORITHM_VERSION } from '../src/audio/analysis-engine';
import { renderRhythm, type SynthLayer } from '../src/audio/synth';
import { getPattern } from '../src/rhythm/library';
import { wrapHalf } from '../src/util/math';

const SR = 44100;
const L = (id: string, gain = 1): SynthLayer => ({ pattern: getPattern(id)!, gain });
const FULL = [L('son-clave-3-2'), L('conga-tumbao-basic'), L('bass-tumbao'), L('campana-bongo-bell', 0.7), L('piano-montuno-generic', 0.6)];

interface Case {
  name: string;
  bpm: number;
  layers: SynthLayer[];
  bpmLo?: number;
  jitterMs?: number;
  dropProb?: number;
  noiseDb?: number;
}

const cases: Case[] = [
  ...[140, 160, 180, 200, 220].map((bpm) => ({ name: 'полный ансамбль', bpm, layers: FULL })),
  { name: 'джиттер 8 мс, 15% пропусков, шум −30 дБ', bpm: 180, layers: FULL, jitterMs: 8, dropProb: 0.15, noiseDb: -30 },
  { name: 'джиттер 15 мс, 25% пропусков, шум −20 дБ', bpm: 180, layers: FULL, jitterMs: 15, dropProb: 0.25, noiseDb: -20 },
  { name: 'только конга', bpm: 180, layers: [L('conga-tumbao-basic')] },
  { name: 'только клаве', bpm: 180, layers: [L('son-clave-3-2')] },
  { name: 'клаве + бас', bpm: 180, layers: [L('son-clave-3-2'), L('bass-tumbao')] },
  { name: 'полный, октава 60–120', bpm: 180, layers: FULL, bpmLo: 60 },
];

function run(c: Case) {
  const seconds = 24;
  const start = 0.37;
  const r = renderRhythm({
    sampleRate: SR, bpm: c.bpm, cycles: Math.ceil((seconds * c.bpm) / 480), clave: '3-2', layers: c.layers, startOffset: start,
    jitterMs: c.jitterMs, dropProb: c.dropProb, noiseDb: c.noiseDb, seed: 7,
  });
  const e = new AnalysisEngine(SR, { bpmLo: c.bpmLo ?? 120 });
  let lock: number | null = null;
  const errs: number[] = [];
  let next = 1;
  const t0 = performance.now();
  for (let i = 0; i + 1024 <= r.samples.length; i += 1024) {
    e.push(i, r.samples.subarray(i, i + 1024));
    const t = (i + 1024) / SR;
    if (lock === null && e.isLocked) lock = t;
    if (t >= next) {
      next += 0.25;
      if (e.isLocked && lock !== null && t > lock + 3) {
        // Compare in the tracker's own beat unit (true tempo x the metrical ratio it locked to),
        // so a half-time or tresillo (2/3) lock is still measurable.
        const ratios = [0.5, 2 / 3, 1, 1.5, 2];
        const q = e.tracker.bpm / r.bpm;
        const ratio = ratios.reduce((a, b) => (Math.abs(b - q) < Math.abs(a - q) ? b : a));
        // Distance from the tracker's beat grid to the nearest TRUE beat (true-beat units).
        const truth = ((t - start) * r.bpm) / 60;
        errs.push((wrapHalf(e.tracker.beatsAt(t) / ratio - truth) * 60000) / r.bpm);
      }
    }
  }
  const cpu = ((performance.now() - t0) / (r.samples.length / SR)) / 10;
  const est = e.tracker.bpm;
  const mean = errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : NaN;
  const max = errs.length ? Math.max(...errs.map(Math.abs)) : NaN;
  return { truth: r.bpm, est, lock, mean, max, cpu };
}

console.log(`Алгоритм: ${ALGORITHM_VERSION}; ${SR} Гц; 24 с сигнала; ошибка фазы — после захвата + 3 с.\n`);
console.log('| Сценарий | Истинный BPM | Найденный BPM | Захват, с | |Δфазы| ср., мс | |Δфазы| макс., мс | CPU, % RT |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const c of cases) {
  const m = run(c);
  const f = (x: number | null, d = 1) => (x === null || Number.isNaN(x) ? '—' : x.toFixed(d));
  console.log(`| ${c.name}${c.bpmLo ? '' : ''} | ${m.truth.toFixed(1)} | ${f(m.est, 2)} | ${f(m.lock)} | ${f(m.mean)} | ${f(m.max)} | ${f(m.cpu, 2)} |`);
}

// ---------------------------------------------------------------- tempo change 180 -> 170
{
  const a = renderRhythm({ sampleRate: SR, bpm: 180, cycles: 5, clave: '3-2', layers: FULL, jitterMs: 4, seed: 9 });
  const b = renderRhythm({ sampleRate: SR, bpm: 170, cycles: 7, clave: '3-2', layers: FULL, jitterMs: 4, seed: 10 });
  const cutA = a.cycleSamples * 5;
  const sig = new Float32Array(cutA + b.samples.length);
  sig.set(a.samples.subarray(0, cutA), 0);
  sig.set(b.samples, cutA);
  const tChange = cutA / SR;
  const e = new AnalysisEngine(SR, {});
  let relock: number | null = null;
  const errs: number[] = [];
  const bpmErr: number[] = [];
  let next = tChange;
  for (let i = 0; i + 1024 <= sig.length; i += 1024) {
    e.push(i, sig.subarray(i, i + 1024));
    const t = (i + 1024) / SR;
    if (t < next) continue;
    next += 0.25;
    const ok = Math.abs(e.tracker.bpm / b.bpm - 1) < 0.01;
    if (ok && relock === null) relock = t - tChange;
    if (!ok) relock = null;
    if (relock !== null && t - tChange > relock + 2) {
      const truth = ((t - tChange) * b.bpm) / 60;
      errs.push(Math.abs(wrapHalf(e.tracker.beatsAt(t) - truth)) * (60000 / b.bpm));
      bpmErr.push(Math.abs(e.tracker.bpm - b.bpm));
    }
  }
  const mean = (x: number[]) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : NaN);
  console.log(`\nСмена темпа 180 → 170 на ${tChange.toFixed(1)} с: перестройка ${relock === null ? '—' : relock.toFixed(1)} с; после неё |ΔBPM| ${mean(bpmErr).toFixed(3)}, |Δфазы| ср. ${mean(errs).toFixed(1)} мс, макс. ${errs.length ? Math.max(...errs).toFixed(1) : '—'} мс`);
}
