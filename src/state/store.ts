import { create } from 'zustand';
import type { ClockMode } from '../audio/analysis-engine';
import type { AccumDisplay } from '../accumulate/polar-spectrogram';
import type { SourceKind } from '../audio/audio-engine';
import { DEFAULT_VISIBLE, type ClaveChoice, type LayerId } from '../viz/layers';
import type { HitTarget } from '../viz/radar-renderer';

export type ViewMode = 'layers' | 'spectrum';
export type FreqScale = 'linear' | 'log';
export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  source: SourceKind;
  view: ViewMode;
  syncMode: ClockMode;
  visible: Record<LayerId, boolean>;
  clave: ClaveChoice;
  dance: string;
  cycleBeats: 4 | 8;
  memoryCycles: number;
  autoPhase: boolean;
  spec: {
    display: AccumDisplay;
    scale: FreqScale;
    /** Radius where frequency 0 (or fLow on log scale) starts, fraction of the dial radius. */
    r0: number;
    fmax: number;
    dbRange: number;
    showRings: boolean;
  };
  demo: { bpm: number; jitterMs: number; dropProb: number; noiseDb: number; volume: number };
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  source: 'demo',
  view: 'layers',
  syncMode: 'reference',
  visible: DEFAULT_VISIBLE,
  clave: { family: 'son', dir: '3-2' },
  dance: 'salsa-on1',
  cycleBeats: 8,
  memoryCycles: 8,
  autoPhase: true,
  spec: { display: 'power', scale: 'log', r0: 0.2, fmax: 5000, dbRange: 60, showRings: true },
  demo: { bpm: 180, jitterMs: 0, dropProb: 0, noiseDb: -120, volume: 0.8 },
  theme: 'auto',
};

const KEY = 'srr.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      visible: { ...DEFAULT_SETTINGS.visible, ...s.visible },
      clave: { ...DEFAULT_SETTINGS.clave, ...s.clave },
      spec: { ...DEFAULT_SETTINGS.spec, ...s.spec },
      demo: { ...DEFAULT_SETTINGS.demo, ...s.demo },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface LiveStats {
  bpm: number;
  confidence: number;
  locked: boolean;
  mode: ClockMode;
}

interface AppState {
  settings: Settings;
  running: boolean;
  starting: boolean;
  error: string | null;
  fileName: string | null;
  info: HitTarget;
  panel: 'none' | 'settings' | 'diagnostics';
  stats: LiveStats;
  set: (p: Partial<Settings>) => void;
  setSpec: (p: Partial<Settings['spec']>) => void;
  setDemo: (p: Partial<Settings['demo']>) => void;
  toggleLayer: (id: LayerId) => void;
  ui: (p: Partial<Omit<AppState, 'settings' | 'set' | 'setSpec' | 'setDemo' | 'toggleLayer' | 'ui'>>) => void;
}

export const useApp = create<AppState>((set, get) => {
  const save = (s: Settings) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* private mode: settings just won't persist */
    }
  };
  const update = (s: Settings) => {
    save(s);
    set({ settings: s });
  };
  return {
    settings: load(),
    running: false,
    starting: false,
    error: null,
    fileName: null,
    info: null,
    panel: 'none',
    stats: { bpm: 0, confidence: 0, locked: false, mode: 'reference' },
    set: (p) => update({ ...get().settings, ...p }),
    setSpec: (p) => update({ ...get().settings, spec: { ...get().settings.spec, ...p } }),
    setDemo: (p) => update({ ...get().settings, demo: { ...get().settings.demo, ...p } }),
    toggleLayer: (id) => {
      const s = get().settings;
      update({ ...s, visible: { ...s.visible, [id]: !s.visible[id] } });
    },
    ui: (p) => set(p),
  };
});
