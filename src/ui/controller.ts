/**
 * Glue between UI state and the audio engine: start/stop, settings sync,
 * demo re-rendering, manual tempo tools.
 */
import { audioEngine, type DemoConfig } from '../audio/audio-engine';
import { t } from '../i18n';
import { getPattern } from '../rhythm/library';
import { useApp, type Settings } from '../state/store';
import { LAYERS, patternForLayer } from '../viz/layers';

export function demoConfig(s: Settings): DemoConfig {
  // Demo plays the visible reference instrument layers.
  const layers = LAYERS.filter((l) => l.kind === 'reference' && s.visible[l.id])
    .map((l) => patternForLayer(l, s.clave))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((pattern) => ({ pattern, gain: pattern.instrument === 'maracas' || pattern.instrument === 'guiro' ? 0.6 : 1 }));
  if (layers.length === 0) layers.push({ pattern: getPattern('son-clave-3-2')!, gain: 1 });
  return { bpm: s.demo.bpm, clave: s.clave.dir, layers, jitterMs: s.demo.jitterMs, dropProb: s.demo.dropProb, noiseDb: s.demo.noiseDb, volume: s.demo.volume };
}

export function engineSettings(s: Settings) {
  return {
    cycleBeats: s.cycleBeats,
    memoryCycles: s.memoryCycles,
    autoPhase: s.autoPhase,
    display: s.spec.display,
    dbRange: s.spec.dbRange,
    fmax: s.spec.fmax,
    autoDownbeat: s.autoDownbeat,
    clave: s.clave.dir,
  };
}

function errorText(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message ?? String(e);
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('micDenied');
  if (msg === 'mic-unsupported') return t('micUnsupported');
  return t('genericError', { msg });
}

export async function start(file?: File): Promise<void> {
  const app = useApp.getState();
  const s = app.settings;
  app.ui({ starting: true, error: null });
  try {
    audioEngine.send({ type: 'settings', settings: engineSettings(s) });
    if (s.source === 'live') {
      await audioEngine.startLive();
      if (s.syncMode !== 'auto') app.set({ syncMode: 'auto' });
    } else if (s.source === 'file') {
      if (!file) throw new Error('no file');
      await audioEngine.startFile(file);
      app.ui({ fileName: file.name });
      if (s.syncMode === 'reference') app.set({ syncMode: 'auto' });
    } else {
      await audioEngine.startDemo(demoConfig(s), s.syncMode);
    }
    audioEngine.send({ type: 'settings', settings: engineSettings(useApp.getState().settings) });
    app.ui({ running: true });
  } catch (e) {
    await audioEngine.stop();
    app.ui({ running: false, error: errorText(e) });
  } finally {
    app.ui({ starting: false });
  }
}

export async function stop(): Promise<void> {
  await audioEngine.stop();
  useApp.getState().ui({ running: false, fileName: null });
}

/** Called when settings change while running. */
export function applySettings(prev: Settings, next: Settings): void {
  if (!audioEngine.running) return;
  audioEngine.send({ type: 'settings', settings: engineSettings(next) });
  if (next.syncMode !== prev.syncMode) {
    if (next.syncMode === 'reference') audioEngine.sendReference();
    else audioEngine.send({ type: 'clockMode', mode: next.syncMode });
  }
  if (audioEngine.sourceKind === 'demo') {
    const a = demoConfig(prev);
    const b = demoConfig(next);
    const sound = (c: DemoConfig) => JSON.stringify({ ...c, layers: c.layers.map((l) => l.pattern.id), volume: 0 });
    if (sound(a) !== sound(b)) audioEngine.updateDemo(b, next.syncMode);
    else if (a.volume !== b.volume) audioEngine.setDemoVolume(b.volume);
  }
}

// ---------------------------------------------------------------- tempo tools

let taps: number[] = [];

export function tap(): void {
  const now = audioEngine.displayTime();
  if (taps.length && now - taps[taps.length - 1] > 2) taps = [];
  taps.push(now);
  if (taps.length > 8) taps.shift();
  if (taps.length >= 2) {
    switchToManualIfReference();
    audioEngine.send({ type: 'taps', times: [...taps] });
  }
}

export function countOne(): void {
  audioEngine.send({ type: 'countOne', time: audioEngine.displayTime() });
}

export function nudge(beats: number): void {
  audioEngine.send({ type: 'nudge', beats });
}

export function scaleBpm(factor: number): void {
  switchToManualIfReference();
  audioEngine.send({ type: 'scaleBpm', factor });
}

export function setBpm(bpm: number): void {
  switchToManualIfReference();
  audioEngine.send({ type: 'setBpm', bpm });
}

/** Manual tempo edits on the Demo ground truth would fake it: switch to manual first. */
function switchToManualIfReference(): void {
  const app = useApp.getState();
  if (app.settings.syncMode === 'reference') {
    app.set({ syncMode: 'manual' });
    audioEngine.send({ type: 'clockMode', mode: 'manual' });
  }
}
