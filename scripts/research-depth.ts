/**
 * Research: how deep should the "tube" be?
 *   npx vite-node scripts/research-depth.ts
 *
 * 1. Additive stacking depth: exponential memory tau = D cycles (D = 1..12),
 *    hierarchical folding. Accuracy over time, BPM error, and the price of
 *    depth: re-lock time after a tempo change 180 -> 170 BPM mid-signal.
 * 2. Multiplicative ("AND") stacking: per-phase geometric mean over the last
 *    K cycles — a tooth counts only if it is present in every ring — vs plain
 *    additive stacking over the same K cycles, single metrical level.
 */
import { FeatureExtractor, N_BANDS } from '../src/dsp/features';
import { fold, searchCycle, type FoldOptions } from '../src/dsp/folding';
import { renderRhythm, type SynthLayer } from '../src/audio/synth';
import { getPattern } from '../src/rhythm/library';

const SR = 44100;
const HOP = 512;
const RATE = SR / HOP;
const L = (id: string, gain = 1): SynthLayer => ({ pattern: getPattern(id)!, gain });
const FULL = () => [L('son-clave-3-2'), L('conga-tumbao-basic'), L('bass-tumbao'), L('campana-bongo-bell', 0.7), L('piano-montuno-generic', 0.6)];

function envelope(samples: Float32Array): Float32Array {
  const fe = new FeatureExtractor(SR, HOP * 2);
  const n = Math.floor((samples.length - HOP * 2) / HOP);
  const env = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    const f = fe.process(samples.subarray(h * HOP, h * HOP + HOP * 2));
    let s = 0;
    for (let b = 0; b < N_BANDS; b++) s += f.flux[b];
    env[h] = s;
  }
  return env;
}
const okRel = (a: number, b: number) => Math.abs(a / b - 1) < 0.02;
const tEndOf = (n: number) => (n - 1) / RATE + HOP / SR;

// ---------------------------------------------------------------- 1. depth sweep
const scen: Array<{ name: string; layers: SynthLayer[]; x?: object; seeds: number[] }> = [
  { name: 'ансамбль', layers: FULL(), seeds: [1, 2] },
  { name: 'джиттер 8, пропуски 15%, шум −30', layers: FULL(), x: { jitterMs: 8, dropProb: 0.15, noiseDb: -30 }, seeds: [1, 2, 3, 4] },
  { name: 'джиттер 15, пропуски 25%, шум −20', layers: FULL(), x: { jitterMs: 15, dropProb: 0.25, noiseDb: -20 }, seeds: [1, 2, 3, 4] },
  { name: 'только конга', layers: [L('conga-tumbao-basic')], seeds: [1] },
  { name: 'клаве + бас', layers: [L('son-clave-3-2'), L('bass-tumbao')], seeds: [1] },
];
const CHECK = [4, 6, 8, 12, 20];
const DEPTHS = [1, 2, 3, 6, 12]; // cycles
const C180 = 480 / 180;

console.log('## 1. Глубина аддитивного наложения (память τ = D восьмёрок, иерархическая свёртка)\n');
console.log('| Глубина D | ' + CHECK.map((c) => `верно к ${c} с`).join(' | ') + ' | |ΔBPM| на 20 с | перестройка 180→170, с |');
console.log('|---:|' + CHECK.map(() => '---:').join('|') + '|---:|---:|');
const envs: Array<{ env: Float32Array; bpm: number }> = [];
for (const sc of scen) for (const seed of sc.seeds) {
  const r = renderRhythm({ sampleRate: SR, bpm: 180, cycles: 9, clave: '3-2', layers: sc.layers, startOffset: 0.37, seed, ...(sc.x ?? {}) });
  envs.push({ env: envelope(r.samples), bpm: r.bpm });
}
// Tempo change: 12 s at 180, then 16 s at 170 (ensemble, light jitter).
const a = renderRhythm({ sampleRate: SR, bpm: 180, cycles: Math.round((12 * 180) / 480), clave: '3-2', layers: FULL(), jitterMs: 4, seed: 9, loop: false });
const b = renderRhythm({ sampleRate: SR, bpm: 170, cycles: Math.round((16 * 170) / 480), clave: '3-2', layers: FULL(), jitterMs: 4, seed: 10, loop: false });
const cutA = a.cycleSamples * Math.round((12 * 180) / 480);
const joined = new Float32Array(cutA + b.samples.length);
joined.set(a.samples.subarray(0, cutA), 0);
joined.set(b.samples, cutA);
const envChange = envelope(joined);
const tChange = cutA / SR;

for (const D of DEPTHS) {
  const opt: FoldOptions = { bins: 64, tau: D * C180 };
  const ok = CHECK.map(() => 0);
  const err: number[] = [];
  for (const { env, bpm } of envs) {
    CHECK.forEach((tc, i) => {
      const n = Math.min(env.length, Math.round(tc * RATE));
      const s = searchCycle(env.subarray(0, n), RATE, tEndOf(n), 2, 4, opt, 0.003);
      if (s.best && okRel(s.best.bpm, bpm)) {
        ok[i]++;
        if (tc === 20) err.push(Math.abs(s.best.bpm - bpm));
      }
    });
  }
  // Re-lock: first time after the change from which the estimate stays within 1 % of 170 BPM.
  let relock: number | null = null;
  for (let t = tChange; t <= tChange + 15; t += 0.5) {
    const n = Math.min(envChange.length, Math.round(t * RATE));
    const s = searchCycle(envChange.subarray(0, n), RATE, tEndOf(n), 2, 4, opt, 0.003);
    const good = !!s.best && Math.abs(s.best.bpm / b.bpm - 1) < 0.01;
    if (good && relock === null) relock = t - tChange;
    if (!good) relock = null;
  }
  const pct = (k: number) => `${Math.round((100 * k) / envs.length)}%`;
  const mean = err.length ? err.reduce((x, y) => x + y, 0) / err.length : NaN;
  console.log(`| ${D} | ${ok.map(pct).join(' | ')} | ${mean.toFixed(3)} | ${relock === null ? '> 15' : relock.toFixed(1)} |`);
}

// ---------------------------------------------------------------- 2. AND-stacking vs sum-stacking
/** Per-cycle profiles of the last K whole cycles (rectangular window), bins per cycle. */
function cycleProfiles(env: Float32Array, n: number, C: number, K: number, B: number): Float32Array[] {
  const tEnd = tEndOf(n);
  const out: Float32Array[] = [];
  for (let k = 0; k < K; k++) {
    const p = new Float32Array(B);
    const w = new Float32Array(B);
    const t1 = tEnd - k * C;
    const t0 = t1 - C;
    for (let i = Math.max(0, Math.floor(t0 * RATE)); i < n && i / RATE < t1; i++) {
      const t = (i + 0.5) / RATE;
      if (t < t0) continue;
      let pos = (t / C) * B;
      pos -= Math.floor(pos / B) * B;
      const j = Math.floor(pos) % B;
      p[j] += env[i];
      w[j] += 1;
    }
    for (let j = 0; j < B; j++) p[j] = w[j] ? p[j] / w[j] : 0;
    out.push(p);
  }
  return out;
}
/** Contrast of a profile: variance / mean^2 (scale-free sharpness). */
const contrast = (p: Float32Array) => {
  let m = 0;
  for (const v of p) m += v;
  m /= p.length;
  let s = 0;
  for (const v of p) s += (v - m) ** 2;
  return s / p.length / (m * m + 1e-12);
};
function scoreSum(ps: Float32Array[]): number {
  const B = ps[0].length;
  const q = new Float32Array(B);
  for (const p of ps) for (let j = 0; j < B; j++) q[j] += p[j] / ps.length;
  return contrast(q);
}
function scoreAnd(ps: Float32Array[]): number {
  const B = ps[0].length;
  const q = new Float32Array(B);
  for (let j = 0; j < B; j++) {
    let lg = 0;
    for (const p of ps) lg += Math.log(p[j] + 1e-3);
    q[j] = Math.exp(lg / ps.length);
  }
  return contrast(q);
}
function bestBy(env: Float32Array, n: number, K: number, scorer: (ps: Float32Array[]) => number): number {
  let best = 0;
  let bestC = 0;
  for (let C = 2; C <= 4; C *= 1.003) {
    const s = scorer(cycleProfiles(env, n, C, K, 32));
    if (s > best) {
      best = s;
      bestC = C;
    }
  }
  return 480 / bestC;
}

console.log('\n## 2. Сложение колец vs «И» (геометрическое среднее по K кольцам), один уровень, верно к 12 с\n');
console.log('| Сценарий | K | сумма | «И» |');
console.log('|---|---:|---:|---:|');
for (const sc of scen) {
  for (const K of [2, 3, 4]) {
    let okS = 0;
    let okA = 0;
    let total = 0;
    for (const seed of sc.seeds) {
      const r = renderRhythm({ sampleRate: SR, bpm: 180, cycles: 6, clave: '3-2', layers: sc.layers, startOffset: 0.37, seed, ...(sc.x ?? {}) });
      const env = envelope(r.samples);
      const n = Math.min(env.length, Math.round(12 * RATE));
      total++;
      if (okRel(bestBy(env, n, K, scoreSum), r.bpm)) okS++;
      if (okRel(bestBy(env, n, K, scoreAnd), r.bpm)) okA++;
    }
    console.log(`| ${sc.name} | ${K} | ${okS}/${total} | ${okA}/${total} |`);
  }
}
void fold;
