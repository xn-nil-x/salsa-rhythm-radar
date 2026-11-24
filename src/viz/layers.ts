import { CLAVE_FAMILIES, getPattern, type ClaveFamily } from '../rhythm/library';
import type { ClaveDirection, RhythmPattern } from '../rhythm/types';

/**
 * Dial layers. Three kinds, always visually distinct:
 *  - reference : documented patterns (coloured discrete segments) — never measurements;
 *  - observed  : what the analysis measured (monochrome "ink" heat, like a sonogram);
 *  - dance     : reference dance timing (grey blocks).
 */
export type LayerKind = 'reference' | 'observed' | 'dance';

export type LayerId =
  | 'clave' | 'conga' | 'bass' | 'campana' | 'bongo' | 'timbales' | 'guiro' | 'maracas' | 'piano'
  | 'obs-all' | 'obs-high' | 'obs-mid' | 'obs-low'
  | 'dance';

export interface LayerDef {
  id: LayerId;
  kind: LayerKind;
  label: string;
  color: string;
  patternId?: string;
  /** Observed: event-density channel (0 low, 1 mid, 2 high, 3 all). */
  channel?: number;
  description: string;
}

export const LAYERS: LayerDef[] = [
  { id: 'clave', kind: 'reference', label: 'Clave', color: '#D9A04E', description: 'Ключевой ритмический рисунок; задаёт направление 3–2 / 2–3.' },
  { id: 'conga', kind: 'reference', label: 'Conga tumbao', color: '#D9675F', patternId: 'conga-tumbao-basic', description: 'Базовый тумбао конги.' },
  { id: 'bass', kind: 'reference', label: 'Bass tumbao', color: '#5DB39E', patternId: 'bass-tumbao', description: 'Антиципированный бас на 2& и 4.' },
  { id: 'campana', kind: 'reference', label: 'Campana', color: '#6E9BE0', patternId: 'campana-bongo-bell', description: 'Колокол бонгосеро в мамбо/монтуно.' },
  { id: 'bongo', kind: 'reference', label: 'Bongó martillo', color: '#E08AB8', patternId: 'bongo-martillo', description: 'Мартильо на бонго.' },
  { id: 'timbales', kind: 'reference', label: 'Timbales cáscara', color: '#C9A227', patternId: 'timbales-cascara-2-3', description: 'Каскара по корпусу тимбалес.' },
  { id: 'guiro', kind: 'reference', label: 'Güiro', color: '#8DB85A', patternId: 'guiro-basic', description: 'Длинный–короткий–короткий.' },
  { id: 'maracas', kind: 'reference', label: 'Maracas', color: '#4FB7C9', patternId: 'maracas-eighths', description: 'Равномерные восьмые.' },
  { id: 'piano', kind: 'reference', label: 'Piano montuno', color: '#A68AD6', patternId: 'piano-montuno-generic', description: 'Гуахео фортепиано (иллюстративный).' },
  { id: 'obs-all', kind: 'observed', label: 'Пульсация: все атаки', color: 'ink', channel: 3, description: 'Атаки по суммарному спектральному потоку.' },
  { id: 'obs-high', kind: 'observed', label: 'Атаки 2–10 кГц', color: 'ink', channel: 2, description: 'Высокочастотный канал.' },
  { id: 'obs-mid', kind: 'observed', label: 'Атаки 0,2–2 кГц', color: 'ink', channel: 1, description: 'Среднечастотный канал.' },
  { id: 'obs-low', kind: 'observed', label: 'Атаки 30–200 Гц', color: 'ink', channel: 0, description: 'Низкочастотный канал.' },
  { id: 'dance', kind: 'dance', label: 'Танец', color: '#9AA3AE', description: 'Эталонная схема шагов.' },
];

export const LAYER_BY_ID = Object.fromEntries(LAYERS.map((l) => [l.id, l])) as Record<LayerId, LayerDef>;

export const DEFAULT_VISIBLE: Record<LayerId, boolean> = {
  clave: true, conga: true, bass: true, campana: true, bongo: false, timbales: false, guiro: false, maracas: false, piano: true,
  'obs-all': false, 'obs-high': true, 'obs-mid': true, 'obs-low': true,
  dance: true,
};

export interface ClaveChoice {
  family: ClaveFamily;
  dir: ClaveDirection;
}

export function patternForLayer(l: LayerDef, clave: ClaveChoice): RhythmPattern | undefined {
  if (l.kind !== 'reference') return undefined;
  if (l.id === 'clave') return getPattern(CLAVE_FAMILIES[clave.family][clave.dir]);
  return l.patternId ? getPattern(l.patternId) : undefined;
}

/** Bands of the observed channels, Hz (for the info panel). */
export const CHANNEL_BANDS = ['30–200 Гц', '200–2000 Гц', '2–10 кГц', '30 Гц – 10 кГц'];
