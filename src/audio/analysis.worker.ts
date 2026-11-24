/// <reference lib="webworker" />
import { AnalysisEngine } from './analysis-engine';
import type { WorkerCommand } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: AnalysisEngine | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const SNAPSHOT_MS = 66;

function publish(): void {
  if (!engine) return;
  const snap = engine.snapshot(true);
  const transfer: Transferable[] = [snap.density.buffer];
  if (snap.spec) transfer.push(snap.spec.buffer);
  self.postMessage(snap, transfer);
}

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const m = e.data;
  if (m.type === 'init') {
    engine = new AnalysisEngine(m.sampleRate, m.settings);
    m.port.onmessage = (ev: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      engine?.push(ev.data.frame, ev.data.samples);
    };
    if (timer) clearInterval(timer);
    timer = setInterval(publish, SNAPSHOT_MS);
    return;
  }
  if (!engine) return;
  switch (m.type) {
    case 'settings':
      engine.updateSettings(m.settings);
      break;
    case 'clockMode':
      engine.setClockMode(m.mode);
      break;
    case 'reference':
      engine.setReference(m.tRef, m.beatRef, m.bpm);
      break;
    case 'setBpm':
      engine.setBpm(m.bpm);
      break;
    case 'scaleBpm':
      engine.scaleBpm(m.factor);
      break;
    case 'countOne':
      engine.setCountOne(m.time);
      break;
    case 'nudge':
      engine.nudge(m.beats);
      break;
    case 'taps':
      engine.applyTaps(m.times);
      break;
    case 'discontinuity':
      engine.discontinuity();
      break;
    case 'resetAccumulators':
      engine.resetAccumulators();
      break;
  }
};
