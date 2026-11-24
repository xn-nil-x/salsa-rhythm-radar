/**
 * Canvas renderer of the circular 8-count dial.
 *
 * Angle = musical phase: count 1 at the top, time runs clockwise.
 * Layers view: concentric rings (reference / observed / dance).
 * Spectrum view: polar spectrogram — angle = phase, radius = frequency
 * (linear from r0, or logarithmic), plus thin orientation rings outside.
 */
import type { EngineSnapshot, ObservedOnset } from '../audio/analysis-engine';
import type { DancePattern } from '../dance/library';
import type { PhaseEvent, RhythmPattern } from '../rhythm/types';
import type { FreqScale, ViewMode } from '../state/store';
import type { LayerDef, LayerId } from './layers';

export interface Palette {
  text: string;
  muted: string;
  grid: string;
  ink: [number, number, number];
  disc: string;
  discText: string;
  needle: string;
  cmap: Uint8ClampedArray;
  dark: boolean;
}

export interface RingSpec {
  layer: LayerDef;
  pattern?: RhythmPattern;
  events?: PhaseEvent[];
  dance?: DancePattern;
}

export interface SpecView {
  scale: FreqScale;
  r0: number;
  fmax: number;
  showRings: boolean;
}

export interface FrameInput {
  view: ViewMode;
  cyclePhase: number;
  cycleBeats: number;
  rings: RingSpec[];
  /** Orientation rings for the spectrum view (outer first). */
  specRings: RingSpec[];
  snapshot: EngineSnapshot | null;
  now: number;
  /** 0..1 — how much the observed phase can be trusted (sync confidence). */
  syncAlpha: number;
  spec: SpecView;
  palette: Palette;
  countLabel: string;
}

export type HitTarget =
  | { kind: 'layer'; id: LayerId }
  | { kind: 'spec'; freq: number; phase: number }
  | null;

const TAU = Math.PI * 2;
const F_LOG_LOW = 40;
const STATUS_ALPHA: Record<string, number> = { established: 1, simplified: 0.8, illustrative: 0.6 };

/** Canvas angle for a cycle phase (0 = top, clockwise). */
const ang = (phase: number): number => phase * TAU - Math.PI / 2;

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

/** Map a phase of the 8-count reference cycle onto the displayed cycle. */
const toCycle = (phase8: number, cycleBeats: number): number => {
  const x = (phase8 * 8) / cycleBeats;
  return x - Math.floor(x);
};

function annulusSeg(ctx: CanvasRenderingContext2D, cx: number, cy: number, r1: number, r2: number, p0: number, p1: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r2, ang(p0), ang(p1));
  ctx.arc(cx, cy, r1, ang(p1), ang(p0), true);
  ctx.closePath();
}

interface RingGeom {
  id: LayerId;
  r1: number;
  r2: number;
}

/** Spectrogram image cache: pixel -> grid index lookup, rebuilt only when geometry changes. */
class SpecImage {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lut: Int32Array = new Int32Array(0);
  private img: ImageData | null = null;
  private key = '';
  size = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  update(spec: Uint8Array, A: number, K: number, binHz: number, view: SpecView, sizePx: number, cmap: Uint8ClampedArray): void {
    const P = Math.max(64, Math.min(720, Math.round(sizePx)));
    const key = `${P}|${A}|${K}|${binHz}|${view.scale}|${view.r0}|${view.fmax}`;
    if (key !== this.key) {
      this.key = key;
      this.size = P;
      this.canvas.width = P;
      this.canvas.height = P;
      this.img = this.ctx.createImageData(P, P);
      this.lut = new Int32Array(P * P).fill(-1);
      const half = P / 2;
      const fTop = Math.min(view.fmax, binHz * (K - 1));
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const dx = x + 0.5 - half;
          const dy = y + 0.5 - half;
          const r = Math.hypot(dx, dy) / half;
          const u = (r - view.r0) / (1 - view.r0);
          if (u < 0 || u > 1) continue;
          const f = view.scale === 'log' ? F_LOG_LOW * Math.pow(fTop / F_LOG_LOW, u) : u * fTop;
          const k = Math.round(f / binHz);
          if (k < 0 || k >= K) continue;
          let th = Math.atan2(dx, -dy);
          if (th < 0) th += TAU;
          const a = Math.round((th / TAU) * A) % A;
          this.lut[y * P + x] = a * K + k;
        }
      }
    }
    const data = this.img!.data;
    const lut = this.lut;
    for (let i = 0; i < lut.length; i++) {
      const j = lut[i];
      const v = j >= 0 ? spec[j] : 0;
      const o = i * 4;
      const c = v * 4;
      data[o] = cmap[c];
      data[o + 1] = cmap[c + 1];
      data[o + 2] = cmap[c + 2];
      data[o + 3] = cmap[c + 3];
    }
    this.ctx.putImageData(this.img!, 0, 0);
  }
}

export class RadarRenderer {
  private ctx: CanvasRenderingContext2D;
  private cssSize = 0;
  private dpr = 1;
  private geom: { cx: number; cy: number; R: number; rings: RingGeom[]; spec: { rOut: number; r0: number; view: SpecView; binHz: number; K: number } | null } = {
    cx: 0, cy: 0, R: 0, rings: [], spec: null,
  };
  private specImg: SpecImage | null = null;
  private lastSpec: Uint8Array | null = null;
  private onsets: ObservedOnset[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssSize: number, dpr: number): void {
    this.cssSize = cssSize;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.canvas.style.width = `${cssSize}px`;
    this.canvas.style.height = `${cssSize}px`;
  }

  /** Feed newly detected onsets (for flashes). */
  addOnsets(list: ObservedOnset[]): void {
    if (list.length) this.onsets.push(...list);
    if (this.onsets.length > 400) this.onsets.splice(0, this.onsets.length - 400);
  }

  draw(f: FrameInput): void {
    const ctx = this.ctx;
    const S = this.cssSize;
    if (S < 120) return; // not laid out yet
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - Math.max(24, S * 0.07);
    this.geom = { cx, cy, R, rings: [], spec: null };
    const now = f.now;
    this.onsets = this.onsets.filter((o) => now - o.time < 0.4);

    let rIn: number;
    if (f.view === 'spectrum') {
      const rings = f.spec.showRings ? f.specRings : [];
      const ringW = Math.max(7, R * 0.055);
      const rSpec = R - rings.length * (ringW + 3) - (rings.length ? 2 : 0);
      this.drawSpectrum(f, cx, cy, rSpec);
      this.drawRings(f, rings, cx, cy, rSpec + 3, R);
      rIn = f.spec.r0 * rSpec;
      this.drawGrid(f, cx, cy, rIn, R, f.spec.r0 < 0.12 ? 0.25 : 1);
      this.drawFreqLabels(f, cx, cy, rSpec);
    } else {
      rIn = R * 0.2;
      this.drawGrid(f, cx, cy, rIn, R, 1);
      this.drawRings(f, f.rings, cx, cy, rIn + 4, R);
    }
    this.drawCountLabels(f, cx, cy, R);
    this.drawNeedle(f, cx, cy, R);
    if (rIn >= R * 0.12) this.drawDisc(f, cx, cy, Math.max(rIn - 3, R * 0.11));
  }

  private drawGrid(f: FrameInput, cx: number, cy: number, r1: number, r2: number, alphaScale: number): void {
    const ctx = this.ctx;
    const n = f.cycleBeats * 4;
    ctx.save();
    ctx.strokeStyle = f.palette.grid;
    for (let i = 0; i < n; i++) {
      const level = i % 4 === 0 ? 0.55 : i % 2 === 0 ? 0.28 : 0.12;
      ctx.globalAlpha = level * alphaScale;
      ctx.lineWidth = i % 4 === 0 ? 1.4 : 1;
      const a = ang(i / n);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * (r2 + 6), cy + Math.sin(a) * (r2 + 6));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5 * alphaScale;
    ctx.beginPath();
    ctx.arc(cx, cy, r2 + 6, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  private drawRings(f: FrameInput, rings: RingSpec[], cx: number, cy: number, rInner: number, rOuter: number): void {
    if (rings.length === 0) return;
    const ctx = this.ctx;
    const total = rOuter - rInner;
    const w = total / rings.length;
    const gap = Math.min(4, w * 0.18);
    rings.forEach((ring, i) => {
      const r2 = rOuter - i * w;
      const r1 = r2 - w + gap;
      this.geom.rings.push({ id: ring.layer.id, r1, r2 });
      ctx.save();
      if (ring.layer.kind === 'reference') this.drawReference(f, ring, cx, cy, r1, r2);
      else if (ring.layer.kind === 'observed') this.drawObserved(f, ring, cx, cy, r1, r2);
      else this.drawDance(f, ring, cx, cy, r1, r2);
      ctx.restore();
    });
  }

  private drawReference(f: FrameInput, ring: RingSpec, cx: number, cy: number, r1: number, r2: number): void {
    const ctx = this.ctx;
    const col = hexRgb(ring.layer.color);
    ctx.fillStyle = rgba(col, f.palette.dark ? 0.1 : 0.12);
    annulusSeg(ctx, cx, cy, r1, r2, 0, 1);
    ctx.fill();
    const statusA = STATUS_ALPHA[ring.pattern?.status ?? 'established'] ?? 1;
    const halfW = (0.7 * 0.25) / f.cycleBeats / 2;
    for (const e of ring.events ?? []) {
      const p = toCycle(e.phase, f.cycleBeats);
      const ext = (e.extent * 8) / f.cycleBeats;
      const p0 = p - halfW;
      const p1 = p + halfW;
      // Sustain (bass, piano, güiro scrape): a pale tail after the attack block.
      if (ext > 2 * halfW) {
        ctx.fillStyle = rgba(col, 0.28 * statusA);
        annulusSeg(ctx, cx, cy, r1 + (r2 - r1) * 0.3, r2 - (r2 - r1) * 0.3, p1, p + ext - halfW * 0.3);
        ctx.fill();
      }
      let d = f.cyclePhase - p0;
      d -= Math.floor(d);
      const active = d <= p1 - p0 + 0.004;
      const a = (0.35 + 0.65 * e.intensity) * statusA;
      ctx.fillStyle = rgba(col, active ? 1 : a * 0.85);
      annulusSeg(ctx, cx, cy, r1, r2, p0, p1);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = f.palette.dark ? 'rgba(255,255,255,0.9)' : 'rgba(20,24,32,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private drawObserved(f: FrameInput, ring: RingSpec, cx: number, cy: number, r1: number, r2: number): void {
    const ctx = this.ctx;
    const ink = f.palette.ink;
    ctx.fillStyle = rgba(ink, 0.05);
    annulusSeg(ctx, cx, cy, r1, r2, 0, 1);
    ctx.fill();
    ctx.strokeStyle = rgba(ink, 0.18);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r2, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    const snap = f.snapshot;
    const ch = ring.layer.channel ?? 3;
    if (snap) {
      const bins = snap.densityBins;
      const d = snap.density.subarray(ch * bins, (ch + 1) * bins);
      let max = 0;
      for (let b = 0; b < bins; b++) if (d[b] > max) max = d[b];
      if (max > 0) {
        for (let b = 0; b < bins; b++) {
          const v = d[b] / max;
          if (v < 0.08) continue;
          ctx.fillStyle = rgba(ink, v * (0.15 + 0.85 * f.syncAlpha));
          // The snapshot is in analysis cycles; bins map 1:1 to the displayed cycle.
          annulusSeg(ctx, cx, cy, r1, r2, b / bins, (b + 1) / bins);
          ctx.fill();
        }
      }
    }
    // Flash the onsets detected in the last 0.4 s.
    for (const o of this.onsets) {
      if (o.channel !== ch) continue;
      const age = f.now - o.time;
      if (age < -0.05) continue;
      const a = Math.max(0, 1 - Math.max(0, age) / 0.4);
      ctx.fillStyle = f.palette.dark ? `rgba(255,236,150,${a})` : `rgba(230,80,20,${a})`;
      annulusSeg(ctx, cx, cy, r1 - 1, r2 + 1, o.phase - 0.006, o.phase + 0.006);
      ctx.fill();
    }
  }

  private drawDance(f: FrameInput, ring: RingSpec, cx: number, cy: number, r1: number, r2: number): void {
    const ctx = this.ctx;
    const col = hexRgb(ring.layer.color);
    ctx.fillStyle = rgba(col, 0.1);
    annulusSeg(ctx, cx, cy, r1, r2, 0, 1);
    ctx.fill();
    const d = ring.dance;
    if (!d) return;
    const w = Math.min(0.5, 0.42) / f.cycleBeats;
    for (const e of d.events) {
      const p = toCycle((e.count - 1) / 8, f.cycleBeats);
      let dd = f.cyclePhase - (p - w / 2);
      dd -= Math.floor(dd);
      const active = dd <= w + 0.01;
      if (e.type === 'pause') {
        const rm = (r1 + r2) / 2;
        const a = ang(p);
        ctx.strokeStyle = rgba(col, 0.9);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm, Math.max(2, (r2 - r1) * 0.18), 0, TAU);
        ctx.stroke();
        continue;
      }
      const strong = e.type === 'break';
      const shrink = e.type === 'tap' ? 0.3 : 0;
      ctx.fillStyle = rgba(col, active ? 1 : strong ? 0.95 : 0.7);
      annulusSeg(ctx, cx, cy, r1 + (r2 - r1) * shrink, r2, p - w / 2, p + w / 2);
      ctx.fill();
      if (strong || active) {
        ctx.strokeStyle = active ? (f.palette.dark ? '#fff' : '#111') : rgba([40, 44, 52], 0.6);
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.stroke();
      }
      if (e.foot && r2 - r1 >= 13) {
        const a = ang(p);
        const rm = (r1 + r2) / 2;
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${Math.min(12, (r2 - r1) * 0.6)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e.foot, cx + Math.cos(a) * rm, cy + Math.sin(a) * rm);
      }
    }
  }

  private drawSpectrum(f: FrameInput, cx: number, cy: number, rSpec: number): void {
    const snap = f.snapshot;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = f.palette.dark ? 'rgba(0,0,6,0.55)' : 'rgba(250,250,248,1)';
    ctx.beginPath();
    ctx.arc(cx, cy, rSpec, 0, TAU);
    ctx.fill();
    ctx.restore();
    if (snap?.spec) this.lastSpec = snap.spec;
    const spec = this.lastSpec;
    if (!spec || !snap) return;
    if (!this.specImg) this.specImg = new SpecImage();
    this.specImg.update(spec, snap.specAngleBins, snap.specFreqBins, snap.specBinHz, f.spec, 2 * rSpec * this.dpr, f.palette.cmap);
    this.geom.spec = { rOut: rSpec, r0: f.spec.r0, view: f.spec, binHz: snap.specBinHz, K: snap.specFreqBins };
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    // The engine accumulates over the displayed cycle length, so the image maps 1:1 onto the dial.
    ctx.drawImage(this.specImg.canvas, cx - rSpec, cy - rSpec, 2 * rSpec, 2 * rSpec);
    ctx.restore();
  }

  private drawFreqLabels(f: FrameInput, cx: number, cy: number, rSpec: number): void {
    const g = this.geom.spec;
    if (!g) return;
    const ctx = this.ctx;
    const fTop = Math.min(f.spec.fmax, g.binHz * (g.K - 1));
    const ticks = f.spec.scale === 'log' ? [100, 250, 500, 1000, 2000, 5000, 10000] : niceLinear(fTop);
    const a = ang(-0.5 / (f.cycleBeats * 4)); // just left of count 1
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const hz of ticks) {
      if (hz > fTop) continue;
      const u = f.spec.scale === 'log' ? Math.log(hz / F_LOG_LOW) / Math.log(fTop / F_LOG_LOW) : hz / fTop;
      if (u < 0) continue;
      const r = (f.spec.r0 + u * (1 - f.spec.r0)) * rSpec;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      ctx.fillStyle = f.palette.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
      const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
      const w = ctx.measureText(label).width + 6;
      ctx.fillRect(x - w - 2, y - 7, w, 14);
      ctx.fillStyle = f.palette.text;
      ctx.fillText(label, x - 4, y);
    }
    ctx.restore();
  }

  private drawCountLabels(f: FrameInput, cx: number, cy: number, R: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = f.palette.text;
    ctx.font = `700 ${Math.max(14, Math.min(22, R * 0.09))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rl = R + Math.max(16, R * 0.1);
    for (let c = 0; c < f.cycleBeats; c++) {
      const a = ang(c / f.cycleBeats);
      ctx.fillText(String(c + 1), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
    }
    ctx.restore();
  }

  private drawNeedle(f: FrameInput, cx: number, cy: number, R: number): void {
    const ctx = this.ctx;
    const a = ang(f.cyclePhase);
    ctx.save();
    ctx.strokeStyle = f.palette.needle;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8));
    ctx.stroke();
    ctx.restore();
  }

  private drawDisc(f: FrameInput, cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = f.palette.disc;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = f.palette.discText;
    ctx.font = `700 ${Math.round(r * 0.62)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.countLabel, cx, cy + r * 0.04);
    ctx.restore();
  }

  hitTest(x: number, y: number, cycleBeats: number): HitTarget {
    const { cx, cy, rings, spec } = this.geom;
    const r = Math.hypot(x - cx, y - cy);
    for (const g of rings) if (r >= g.r1 - 2 && r <= g.r2 + 2) return { kind: 'layer', id: g.id };
    if (spec && r <= spec.rOut) {
      const u = (r / spec.rOut - spec.r0) / (1 - spec.r0);
      if (u < 0) return null;
      const fTop = Math.min(spec.view.fmax, spec.binHz * (spec.K - 1));
      const freq = spec.view.scale === 'log' ? F_LOG_LOW * Math.pow(fTop / F_LOG_LOW, u) : u * fTop;
      let th = Math.atan2(x - cx, -(y - cy));
      if (th < 0) th += TAU;
      return { kind: 'spec', freq, phase: (th / TAU) * (cycleBeats / 8) };
    }
    return null;
  }
}

function niceLinear(top: number): number[] {
  const step = top > 6000 ? 2000 : top > 3000 ? 1000 : top > 1200 ? 500 : 250;
  const out: number[] = [];
  for (let f = step; f < top; f += step) out.push(f);
  return out;
}
