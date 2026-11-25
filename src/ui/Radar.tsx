import { useEffect, useRef } from 'react';
import { audioEngine } from '../audio/audio-engine';
import type { ClockState } from '../audio/analysis-engine';
import { getDancePattern } from '../dance/library';
import { patternPhases } from '../rhythm/library';
import { useApp, type Settings } from '../state/store';
import { INFERNO, INK } from '../viz/colormap';
import { LAYERS, LAYER_BY_ID, patternForLayer } from '../viz/layers';
import { RadarRenderer, type Palette, type RingSpec } from '../viz/radar-renderer';
import { useResolvedDark } from './theme';
import { displayClock } from './display-clock';

/** Smoothly follows the analysis clock: small corrections are blended, large ones snap. */
class DisplayClock {
  private beats = Number.NaN;
  private lastT = 0;

  update(t: number, c: ClockState): number {
    const target = c.beatRef + ((t - c.tRef) * c.bpm) / 60 + c.offset;
    const pred = this.beats + ((t - this.lastT) * c.bpm) / 60;
    this.beats = Number.isNaN(pred) || Math.abs(target - pred) > 0.25 ? target : pred + (target - pred) * 0.2;
    this.lastT = t;
    return this.beats;
  }
}

export function buildRings(s: Settings): RingSpec[] {
  return LAYERS.filter((l) => s.visible[l.id]).map((layer) => {
    if (layer.kind === 'reference') {
      const pattern = patternForLayer(layer, s.clave);
      return { layer, pattern, events: pattern ? patternPhases(pattern, s.clave.dir) : [] };
    }
    if (layer.kind === 'dance') return { layer, dance: getDancePattern(s.dance) };
    return { layer };
  });
}

function palette(dark: boolean): Palette {
  return dark
    ? { text: '#E8ECF2', muted: '#8A94A6', grid: '#7C8799', ink: [235, 238, 244], disc: '#E8ECF2', discText: '#151A24', needle: '#F4F6FA', cmap: INFERNO, dark }
    : { text: '#1B2230', muted: '#6B7385', grid: '#9AA2B1', ink: [22, 26, 36], disc: '#2A3140', discText: '#FFFFFF', needle: '#111418', cmap: INK, dark };
}

export function Radar({ onPhase }: { onPhase: (beats: number) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dark = useResolvedDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  const rendererRef = useRef<RadarRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const renderer = new RadarRenderer(canvas);
    rendererRef.current = renderer;
    const ro = new ResizeObserver(() => {
      const size = Math.floor(Math.min(wrap.clientWidth, 620));
      renderer.resize(size, Math.min(window.devicePixelRatio || 1, 2));
    });
    ro.observe(wrap);
    const unsub = audioEngine.onSnapshot((s) => renderer.addOnsets(s.onsets));

    const clock = new DisplayClock();
    let lastBeats = 0;
    let raf = 0;
    let lastPhaseReport = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const st = useApp.getState();
      const s = st.settings;
      const snap = audioEngine.latest;
      const running = audioEngine.running;
      const t = audioEngine.displayTime();
      if (running && snap) lastBeats = clock.update(t, snap.clock);
      displayClock.beats = lastBeats;
      displayClock.running = running && !!snap;
      const cb = s.cycleBeats;
      const inCycle = ((lastBeats % cb) + cb) % cb;
      const q = Math.floor(inCycle * 4);
      const countLabel = `${Math.floor(q / 4) + 1}.${(q % 4) + 1}`;

      let syncAlpha = 1;
      if (snap?.clock.mode === 'auto') syncAlpha = snap.tracker.locked ? Math.min(1, 0.3 + snap.tracker.confidence) : 0.15;

      const clave = LAYER_BY_ID.clave;
      const pat = patternForLayer(clave, s.clave);
      const specRings: RingSpec[] = [
        { layer: clave, pattern: pat, events: pat ? patternPhases(pat, s.clave.dir) : [] },
        { layer: LAYER_BY_ID['obs-all'] },
      ];
      renderer.draw({
        view: s.view,
        cyclePhase: inCycle / cb,
        cycleBeats: cb,
        rings: buildRings(s),
        specRings,
        snapshot: running ? snap : null,
        now: t,
        syncAlpha,
        spec: { scale: s.spec.scale, r0: s.spec.r0, fmax: s.spec.fmax, showRings: s.spec.showRings },
        palette: palette(darkRef.current),
        countLabel,
      });
      const nowMs = performance.now();
      if (nowMs - lastPhaseReport > 100) {
        lastPhaseReport = nowMs;
        onPhaseRef.current(inCycle);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
    };
  }, []);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const hit = rendererRef.current?.hitTest(e.clientX - r.left, e.clientY - r.top, useApp.getState().settings.cycleBeats);
    useApp.getState().ui({ info: hit ?? null });
  };

  return (
    <div className="radar-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} onClick={onClick} role="img" aria-label="Круговой циферблат ритма: восемь счетов, слои инструментов и наблюдений" />
    </div>
  );
}
