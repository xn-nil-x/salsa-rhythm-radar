/**
 * Main-thread audio graph: sources (Live / File / Demo) -> capture worklet ->
 * analysis worker. Also owns the display clock (what is heard now).
 *
 *   mic ─────────────┐
 *   <audio> ─┬───────┼─> capture worklet ──port──> analysis worker ──snapshots──> UI
 *   demo buf ┘       │
 *            └─> speakers (File / Demo only; the mic is never played back)
 *
 * Audio never leaves the device.
 */
import type { ClockMode, EngineSettings, EngineSnapshot } from './analysis-engine';
import type { WorkerCommand } from './protocol';
import { renderRhythm, type SynthLayer } from './synth';
import type { ClaveDirection } from '../rhythm/types';

export type SourceKind = 'live' | 'file' | 'demo';

export interface DemoConfig {
  bpm: number;
  clave: ClaveDirection;
  layers: SynthLayer[];
  jitterMs: number;
  dropProb: number;
  noiseDb: number;
  volume: number;
}

export interface DemoClock {
  tRef: number;
  beatRef: number;
  bpm: number;
}

type Listener = (s: EngineSnapshot) => void;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private worker: Worker | null = null;
  private capture: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: SourceKind | null = null;
  private stream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private mediaEl: HTMLAudioElement | null = null;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private fileUrl: string | null = null;
  private demoSrc: AudioBufferSourceNode | null = null;
  private demoGain: GainNode | null = null;
  private demoCycles = 1;
  demoClock: DemoClock | null = null;
  private listeners = new Set<Listener>();
  latest: EngineSnapshot | null = null;
  private pendingSettings: Partial<EngineSettings> = {};

  get running(): boolean {
    return this.source !== null;
  }

  get sourceKind(): SourceKind | null {
    return this.source;
  }

  get media(): HTMLAudioElement | null {
    return this.mediaEl;
  }

  onSnapshot(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Create the context, worklet and worker. Must run inside a user gesture. */
  private async ensure(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}capture-worklet.js`);
    const capture = new AudioWorkletNode(ctx, 'srr-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    // Keep the worklet pulled by the graph on every browser: route to a muted sink.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    capture.connect(mute).connect(ctx.destination);
    const sink = ctx.createGain();
    sink.connect(ctx.destination);

    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    const ch = new MessageChannel();
    capture.port.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
    worker.postMessage({ type: 'init', sampleRate: ctx.sampleRate, settings: this.pendingSettings, port: ch.port1 } satisfies WorkerCommand, [ch.port1]);
    worker.onmessage = (e: MessageEvent<EngineSnapshot>) => {
      this.latest = e.data;
      for (const l of this.listeners) l(e.data);
    };
    this.ctx = ctx;
    this.capture = capture;
    this.sink = sink;
    this.worker = worker;
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  send(cmd: WorkerCommand): void {
    if (cmd.type === 'settings') this.pendingSettings = { ...this.pendingSettings, ...cmd.settings };
    this.worker?.postMessage(cmd);
  }

  // ------------------------------------------------------------ sources

  async startLive(): Promise<void> {
    const ctx = await this.ensure();
    this.stopSource();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('mic-unsupported');
    // Raw signal: browser speech processing would destroy transients.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.micNode = ctx.createMediaStreamSource(this.stream);
    this.micNode.connect(this.capture!);
    this.source = 'live';
    this.send({ type: 'discontinuity' });
    this.send({ type: 'clockMode', mode: 'auto' });
  }

  async startFile(file: File): Promise<HTMLAudioElement> {
    const ctx = await this.ensure();
    this.stopSource();
    this.fileUrl = URL.createObjectURL(file);
    const el = new Audio();
    el.src = this.fileUrl;
    el.preload = 'auto';
    this.mediaEl = el;
    this.mediaNode = ctx.createMediaElementSource(el);
    this.mediaNode.connect(this.capture!);
    this.mediaNode.connect(this.sink!);
    el.addEventListener('seeking', () => this.send({ type: 'discontinuity' }));
    this.source = 'file';
    this.send({ type: 'discontinuity' });
    this.send({ type: 'clockMode', mode: 'auto' });
    await el.play();
    return el;
  }

  async startDemo(cfg: DemoConfig, syncMode: ClockMode): Promise<void> {
    const ctx = await this.ensure();
    if (this.source !== 'demo') {
      this.stopSource();
      this.send({ type: 'discontinuity' });
    }
    this.playDemo(ctx, cfg, syncMode);
    this.source = 'demo';
  }

  /** (Re)render and start the demo loop, keeping musical time continuous. */
  updateDemo(cfg: DemoConfig, syncMode: ClockMode): void {
    if (this.source === 'demo' && this.ctx) this.playDemo(this.ctx, cfg, syncMode);
  }

  private playDemo(ctx: AudioContext, cfg: DemoConfig, syncMode: ClockMode): void {
    const humanized = cfg.jitterMs > 0 || cfg.dropProb > 0;
    this.demoCycles = humanized ? 4 : 1;
    const r = renderRhythm({
      sampleRate: ctx.sampleRate,
      bpm: cfg.bpm,
      cycles: this.demoCycles,
      clave: cfg.clave,
      layers: cfg.layers,
      jitterMs: cfg.jitterMs,
      dropProb: cfg.dropProb,
      noiseDb: cfg.noiseDb > -100 ? cfg.noiseDb : undefined,
      seed: 1234,
      loop: true,
    });
    const buf = ctx.createBuffer(1, r.samples.length, ctx.sampleRate);
    buf.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);

    const when = ctx.currentTime + 0.06;
    const prev = this.demoClock;
    const beatsAtWhen = prev ? prev.beatRef + ((when - prev.tRef) * prev.bpm) / 60 : 0;
    const loopBeats = 8 * this.demoCycles;
    const posBeats = ((beatsAtWhen % loopBeats) + loopBeats) % loopBeats;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = cfg.volume;
    src.connect(gain);
    gain.connect(this.capture!);
    gain.connect(this.sink!);
    src.start(when, (posBeats * 60) / r.bpm);

    if (this.demoSrc) {
      const old = this.demoSrc;
      const oldGain = this.demoGain;
      old.stop(when);
      old.onended = () => {
        old.disconnect();
        oldGain?.disconnect();
      };
    }
    this.demoSrc = src;
    this.demoGain = gain;
    this.demoClock = { tRef: when, beatRef: beatsAtWhen, bpm: r.bpm };
    if (syncMode === 'reference') this.sendReference();
    else this.send({ type: 'clockMode', mode: syncMode });
  }

  sendReference(): void {
    const c = this.demoClock;
    if (c) this.send({ type: 'reference', tRef: c.tRef, beatRef: c.beatRef, bpm: c.bpm });
  }

  setDemoVolume(v: number): void {
    if (this.demoGain) this.demoGain.gain.value = v;
  }

  private stopSource(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.micNode?.disconnect();
    this.micNode = null;
    if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.removeAttribute('src');
    }
    this.mediaNode?.disconnect();
    this.mediaNode = null;
    this.mediaEl = null;
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = null;
    try {
      this.demoSrc?.stop();
    } catch {
      /* not started */
    }
    this.demoSrc?.disconnect();
    this.demoGain?.disconnect();
    this.demoSrc = null;
    this.demoGain = null;
    this.demoClock = null;
    this.source = null;
  }

  async stop(): Promise<void> {
    this.stopSource();
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  // ------------------------------------------------------------ clocks

  /** Audio-clock time of what the user hears (or, for Live, what is being captured) now. */
  displayTime(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (this.source === 'live') return ctx.currentTime;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || 0);
  }

  latencyInfo(): { base: number; output: number; sampleRate: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    return { base: ctx.baseLatency || 0, output: ctx.outputLatency || 0, sampleRate: ctx.sampleRate };
  }
}

export const audioEngine = new AudioEngine();
