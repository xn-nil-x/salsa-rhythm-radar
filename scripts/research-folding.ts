/**
 * Research: tempo estimation by epoch folding vs beat-level ACF.
 *   npx vite-node scripts/research-folding.ts
 * Same synthetic signals, same onset envelope; checkpoints after start.
 */
import { FeatureExtractor, N_BANDS } from '../src/dsp/features';
import { estimateTempo } from '../src/dsp/tempo';
import { beatGrid, searchCycle } from '../src/dsp/folding';
import { renderRhythm, type SynthLayer } from '../src/audio/synth';
import { getPattern } from '../src/rhythm/library';
import { wrapHalf } from '../src/util/math';

const SR = 44100;
const HOP = 512;
const RATE = SR / HOP;
const L = (id: string, gain = 1): SynthLayer => ({ pattern: getPattern(id)!, gain });
const FULL = () => [L('son-clave-3-2'), L('conga-tumbao-basic'), L('bass-tumbao'), L('campana-bongo-bell', 0.7), L('piano-montuno-generic', 0.6)];

interface Scenario { name: string; bpm: number; layers: SynthLayer[]; jitterMs?: number; dropProb?: number; noiseDb?: number; seeds: number[] }
const scenarios: Scenario[] = [
  { name: 'ансамбль 150–210', bpm: 0, layers: FULL(), seeds: [1] },
  { name: 'ансамбль + джиттер 8 мс, 15% пропусков, шум −30', bpm: 180, layers: FULL(), jitterMs: 8, dropProb: 0.15, noiseDb: -30, seeds: [1, 2, 3, 4, 5, 6, 7, 8] },
  { name: 'ансамбль + джиттер 15 мс, 25% пропусков, шум −20', bpm: 180, layers: FULL(), jitterMs: 15, dropProb: 0.25, noiseDb: -20, seeds: [1, 2, 3, 4, 5, 6, 7, 8] },
  { name: 'только конга', bpm: 180, layers: [L('conga-tumbao-basic')], seeds: [1] },
  { name: 'только клаве', bpm: 180, layers: [L('son-clave-3-2')], seeds: [1] },
  { name: 'клаве + бас', bpm: 180, layers: [L('son-clave-3-2'), L('bass-tumbao')], seeds: [1] },
  { name: 'бас + монтуно (без сильных долей)', bpm: 180, layers: [L('bass-tumbao'), L('piano-montuno-generic')], seeds: [1] },
  { name: 'клаве + конга + бас, джиттер 10 мс', bpm: 175, layers: [L('son-clave-3-2'), L('conga-tumbao-basic'), L('bass-tumbao')], jitterMs: 10, seeds: [1, 2, 3, 4] },
];
const CHECK = [4, 6, 8, 10, 12, 16, 20];

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

interface Tally { ok: number; n: number; bpmErr: number[]; phaseErr: number[] }
const newTally = (): Tally => ({ ok: 0, n: 0, bpmErr: [], phaseErr: [] });
const okRel = (est: number, truth: number) => Math.abs(est / truth - 1) < 0.02;

const sharpOk: number[] = [];
const sharpBad: number[] = [];
const marginOk: number[] = [];
const marginBad: number[] = [];

console.log('| Сценарий | Метод | ' + CHECK.map((c) => `${c} с`).join(' | ') + ' | |ΔBPM| | |Δфазы| мс |');
console.log('|---|---|' + CHECK.map(() => '---:').join('|') + '|---:|---:|');

for (const sc of scenarios) {
  const runs: Array<{ bpm: number; seed: number }> = sc.bpm === 0 ? [150, 165, 180, 195, 210].map((b) => ({ bpm: b, seed: 1 })) : sc.seeds.map((s) => ({ bpm: sc.bpm, seed: s }));
  const acf = CHECK.map(newTally);
  const fol = CHECK.map(newTally);
  const pln = CHECK.map(newTally);
  for (const run of runs) {
    const start = 0.37;
    const r = renderRhythm({
      sampleRate: SR, bpm: run.bpm, cycles: Math.ceil((22 * run.bpm) / 480), clave: '3-2', layers: sc.layers, startOffset: start,
      jitterMs: sc.jitterMs, dropProb: sc.dropProb, noiseDb: sc.noiseDb, seed: run.seed,
    });
    const env = envelope(r.samples);
    CHECK.forEach((tc, ci) => {
      const nEnd = Math.min(env.length, Math.round(tc * RATE));
      const tEnd = (nEnd - 1) / RATE + HOP / SR; // frame centre of the last hop
      // Baseline: current method (ACF on the last 8 s, octave 120..240).
      const seg = env.subarray(Math.max(0, nEnd - Math.round(8 * RATE)), nEnd);
      const a = estimateTempo(seg, RATE, 120, 240);
      acf[ci].n++;
      if (a.bpm > 0 && okRel(a.bpm, r.bpm)) { acf[ci].ok++; acf[ci].bpmErr.push(Math.abs(a.bpm - r.bpm)); }
      // Folding over the whole history up to tc (exponential memory), cycle in [2, 4] s.
      const sp = searchCycle(env.subarray(0, nEnd), RATE, tEnd, 8 * 60 / 240, 8 * 60 / 120, undefined, 0.002, 'plain');
      pln[ci].n++;
      if (sp.best && okRel(sp.best.bpm, r.bpm)) { pln[ci].ok++; pln[ci].bpmErr.push(Math.abs(sp.best.bpm - r.bpm)); }
      const s = searchCycle(env.subarray(0, nEnd), RATE, tEnd, 8 * 60 / 240, 8 * 60 / 120, undefined, 0.002, 'metrical');
      fol[ci].n++;
      if (s.best) {
        const good = okRel(s.best.bpm, r.bpm);
        (good ? sharpOk : sharpBad).push(s.best.sharpness);
        if (Number.isFinite(s.margin)) (good ? marginOk : marginBad).push(s.margin);
        if (good) {
          fol[ci].ok++;
          fol[ci].bpmErr.push(Math.abs(s.best.bpm - r.bpm));
          // Beat phase from the folded profile vs the true beat grid.
          const prof = searchProfile(env.subarray(0, nEnd), tEnd, s.best.period);
          const g = beatGrid(prof);
          const beatT = g.offset * s.best.period; // a beat time modulo the cycle (fold uses t / C)
          const truthBeats = ((beatT - start) * r.bpm) / 60;
          fol[ci].phaseErr.push(Math.abs(wrapHalf(truthBeats)) * (60000 / r.bpm));
        }
      }
    });
  }
  const fmt = (ts: Tally[]) => ts.map((t) => `${Math.round((100 * t.ok) / t.n)}%`).join(' | ');
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const late = (ts: Tally[]) => ts.slice(-3).flatMap((t) => t.bpmErr);
  const latePh = (ts: Tally[]) => ts.slice(-3).flatMap((t) => t.phaseErr);
  console.log(`| ${sc.name} | ACF 8 с | ${fmt(acf)} | ${mean(late(acf)).toFixed(2)} | — |`);
  console.log(`| | свёртка (1 уровень) | ${fmt(pln)} | ${mean(late(pln)).toFixed(2)} | — |`);
  console.log(`| | **свёртка иерарх.** | ${fmt(fol)} | ${mean(late(fol)).toFixed(2)} | ${mean(latePh(fol)).toFixed(1)} |`);
}

import { fold } from '../src/dsp/folding';
function searchProfile(env: Float32Array, tEnd: number, C: number): Float32Array {
  return fold(env, RATE, tEnd, C).profile;
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
console.log(`\nЧёткость (sharpness) лучшего пика: верные — медиана ${q(sharpOk, 0.5).toFixed(1)}, 10% ${q(sharpOk, 0.1).toFixed(1)}; неверные — медиана ${q(sharpBad, 0.5).toFixed(1)}, 90% ${q(sharpBad, 0.9).toFixed(1)} (n=${sharpOk.length}/${sharpBad.length})`);
console.log(`Отрыв от второй гипотезы (margin): верные — медиана ${q(marginOk, 0.5).toFixed(2)}, 10% ${q(marginOk, 0.1).toFixed(2)}; неверные — медиана ${q(marginBad, 0.5).toFixed(2)}, 90% ${q(marginBad, 0.9).toFixed(2)}`);

// ---------------------------------------------------------------- phase methods (t = 20 s)
import { patternPhases } from '../src/rhythm/library';
import { patternProfile } from '../src/rhythm/matching';

function circPeak(v: Float32Array): number {
  const n = v.length;
  let b = 0;
  for (let i = 1; i < n; i++) if (v[i] > v[b]) b = i;
  const y0 = v[(b - 1 + n) % n], y1 = v[b], y2 = v[(b + 1) % n];
  const d = y0 - 2 * y1 + y2;
  return b + (d < 0 ? (0.5 * (y0 - y2)) / d : 0);
}
function templateRotation(profile: Float32Array, tmpl: Float32Array): number {
  const n = profile.length;
  const mp = profile.reduce((a, b) => a + b, 0) / n;
  const corr = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (profile[(i + r) % n] - mp) * tmpl[i];
    corr[r] = s;
  }
  return circPeak(corr);
}
const skeleton = (() => {
  const B = 64;
  const t = new Float32Array(B);
  for (const id of ['conga-tumbao-basic', 'bass-tumbao', 'campana-bongo-bell']) {
    const prof = patternProfile(patternPhases(getPattern(id)!, '3-2'), B, 1.0);
    const m = prof.reduce((a, b) => a + b, 0) / B;
    let norm = 0;
    for (const v of prof) norm += (v - m) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < B; i++) t[i] += (prof[i] - m) / norm;
  }
  return t;
})();

console.log('\n| Сценарий | A: гребёнка по восьмёрке, мс | B: пик на уровне доли, мс | C: скелет сальсы, мс | C: «1» найдена |');
console.log('|---|---:|---:|---:|---:|');
for (const sc of scenarios) {
  const runs: Array<{ bpm: number; seed: number }> = sc.bpm === 0 ? [150, 165, 180, 195, 210].map((b) => ({ bpm: b, seed: 1 })) : sc.seeds.map((s) => ({ bpm: sc.bpm, seed: s }));
  const eA: number[] = [], eB: number[] = [], eC: number[] = [];
  let downOk = 0;
  for (const run of runs) {
    const start = 0.37;
    const r = renderRhythm({ sampleRate: SR, bpm: run.bpm, cycles: Math.ceil((22 * run.bpm) / 480), clave: '3-2', layers: sc.layers, startOffset: start, jitterMs: sc.jitterMs, dropProb: sc.dropProb, noiseDb: sc.noiseDb, seed: run.seed });
    const env = envelope(r.samples);
    const nEnd = Math.min(env.length, Math.round(20 * RATE));
    const tEnd = (nEnd - 1) / RATE + HOP / SR;
    const s = searchCycle(env.subarray(0, nEnd), RATE, tEnd, 2, 4);
    if (!s.best) continue;
    const C = s.best.period;
    const beat = C / 8;
    const err = (tBeat: number) => Math.abs(wrapHalf(((tBeat - start) * r.bpm) / 60)) * (60000 / r.bpm);
    const prof = fold(env.subarray(0, nEnd), RATE, tEnd, C).profile;
    eA.push(err(beatGrid(prof).offset * C));
    const pb = fold(env.subarray(0, nEnd), RATE, tEnd, beat, { bins: 24, tau: 8 }).profile;
    eB.push(err((circPeak(pb) / 24) * beat));
    const rot = templateRotation(prof, skeleton);
    const tOne = (rot / 64) * C; // count 1 (cycle start) modulo C
    eC.push(err(tOne));
    const cyc = ((tOne - start) / C) % 1;
    if (Math.abs(cyc - Math.round(cyc)) * 8 < 0.25) downOk++;
  }
  const m = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  const mx = (a: number[]) => Math.max(...a).toFixed(0);
  console.log(`| ${sc.name} | ${m(eA)} (макс ${mx(eA)}) | ${m(eB)} (макс ${mx(eB)}) | ${m(eC)} (макс ${mx(eC)}) | ${downOk}/${runs.length} |`);
}
