import type { ClockMode, EngineSettings } from './analysis-engine';

/** Messages from the main thread to the analysis worker. */
export type WorkerCommand =
  | { type: 'init'; sampleRate: number; settings: Partial<EngineSettings>; port: MessagePort }
  | { type: 'settings'; settings: Partial<EngineSettings> }
  | { type: 'clockMode'; mode: ClockMode }
  | { type: 'reference'; tRef: number; beatRef: number; bpm: number }
  | { type: 'setBpm'; bpm: number }
  | { type: 'scaleBpm'; factor: number }
  | { type: 'countOne'; time: number }
  | { type: 'nudge'; beats: number }
  | { type: 'taps'; times: number[] }
  | { type: 'discontinuity' }
  | { type: 'resetAccumulators' };
