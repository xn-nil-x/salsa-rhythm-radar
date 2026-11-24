/**
 * Render a synthetic salsa loop to a 16-bit WAV with known tempo — for
 * testing File mode and for listening to the reference patterns offline.
 *   npx vite-node scripts/make-wav.ts -- out.wav 180 3-2 [seconds]
 */
import { writeFileSync } from 'node:fs';
import { renderRhythm } from '../src/audio/synth';
import { getPattern } from '../src/rhythm/library';
import type { ClaveDirection } from '../src/rhythm/types';

const args = process.argv.slice(2).filter((a) => a !== '--');
const [out = 'salsa-demo.wav', bpmArg = '180', claveArg = '3-2', secArg = '30'] = args;
const sr = 44100;
const bpm = Number(bpmArg);
const clave = claveArg as ClaveDirection;
const ids = ['son-clave-3-2', 'conga-tumbao-basic', 'bass-tumbao', 'campana-bongo-bell', 'piano-montuno-generic'];
if (clave === '2-3') ids[0] = 'son-clave-2-3';
const r = renderRhythm({
  sampleRate: sr,
  bpm,
  cycles: Math.ceil((Number(secArg) * bpm) / 60 / 8),
  clave,
  layers: ids.map((id) => ({ pattern: getPattern(id)!, gain: 1 })),
  jitterMs: 4,
  seed: 3,
});

const n = r.samples.length;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + n * 2, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r.samples[i])) * 32767), 44 + i * 2);
writeFileSync(out, buf);
console.log(`${out}: ${(n / sr).toFixed(1)} s, ${r.bpm.toFixed(3)} BPM, clave ${clave}, ${r.events.length} events`);
