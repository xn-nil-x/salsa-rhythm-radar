import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/audio-engine';
import type { ClockMode } from '../audio/analysis-engine';
import { t } from '../i18n';
import { useApp } from '../state/store';
import type { SourceKind } from '../audio/audio-engine';
import { countOne, nudge, scaleBpm, setBpm, start, stop, tap } from './controller';

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function SourceBar() {
  const source = useApp((s) => s.settings.source);
  const running = useApp((s) => s.running);
  const starting = useApp((s) => s.starting);
  const set = useApp((s) => s.set);
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = async (src: SourceKind) => {
    if (src === source) return;
    if (running) await stop();
    set({ source: src, syncMode: src === 'demo' ? 'reference' : 'auto' });
  };

  const onStart = () => {
    if (running) return void stop();
    if (source === 'file') fileRef.current?.click();
    else void start();
  };

  return (
    <div className="source-bar">
      <Segmented<SourceKind>
        label="Источник"
        value={source}
        onChange={choose}
        options={[['live', t('srcLive')], ['file', t('srcFile')], ['demo', t('srcDemo')]]}
      />
      <button className={`primary ${running ? 'stop' : ''}`} onClick={onStart} disabled={starting}>
        {starting ? t('starting') : running ? t('stop') : source === 'file' ? t('chooseFile') : t('start')}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void start(f);
        }}
      />
    </div>
  );
}

export function FileTransport() {
  const running = useApp((s) => s.running);
  const fileName = useApp((s) => s.fileName);
  const [, force] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [running]);
  const el = audioEngine.media;
  if (!running || !el) return null;
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div className="file-transport">
      <button onClick={() => (el.paused ? el.play() : el.pause())} aria-label={el.paused ? 'Воспроизвести' : 'Пауза'}>
        {el.paused ? '▶' : '❚❚'}
      </button>
      <input type="range" min={0} max={dur || 1} step={0.1} value={el.currentTime} onChange={(e) => (el.currentTime = Number(e.target.value))} aria-label="Позиция" />
      <span className="mono small">{fmt(el.currentTime)} / {fmt(dur)}</span>
      <span className="muted small ellipsis">{fileName}</span>
    </div>
  );
}

export function PhaseBar({ beats }: { beats: number }) {
  const cb = useApp((s) => s.settings.cycleBeats);
  const deg = Math.round((beats / cb) * 360) % 360;
  return (
    <div className="phase-bar">
      <div className="row between">
        <span className="muted">{t('phase')}</span>
        <span className="mono">{deg}°</span>
      </div>
      <div className="phase-track" aria-hidden>
        <div className="phase-fill" style={{ width: `${(beats / cb) * 100}%` }} />
        {Array.from({ length: cb }, (_, i) => (
          <span key={i} className="phase-tick" style={{ left: `${(i / cb) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

export function TempoTools() {
  const s = useApp((st) => st.settings);
  const set = useApp((st) => st.set);
  const running = useApp((st) => st.running);
  const stats = useApp((st) => st.stats);
  const syncOptions: Array<[ClockMode, string]> = [['auto', t('syncAuto')], ['manual', t('syncManual')]];
  if (s.source === 'demo') syncOptions.push(['reference', t('syncReference')]);
  const bpm = Math.round(stats.bpm || s.demo.bpm);
  return (
    <div className="tools">
      <div className="tool-row">
        <button className="big" onClick={tap} disabled={!running} title="Отстучите доли — темп и фаза по нажатиям">{t('tap')}</button>
        <button className="big" onClick={countOne} disabled={!running} title="Нажмите на счёт «1»">{t('countOne')}</button>
      </div>
      <div className="tool-row">
        <button onClick={() => setBpm(bpm - 1)} disabled={!running} aria-label="Уменьшить BPM">−1</button>
        <button onClick={() => setBpm(bpm + 1)} disabled={!running} aria-label="Увеличить BPM">+1</button>
        <button onClick={() => scaleBpm(0.5)} disabled={!running} title="Половинный темп">÷2</button>
        <button onClick={() => scaleBpm(2)} disabled={!running} title="Двойной темп">×2</button>
        <button onClick={() => nudge(-0.25)} disabled={!running} title="Сдвиг фазы на шестнадцатую назад">◀ ¼</button>
        <button onClick={() => nudge(0.25)} disabled={!running} title="Сдвиг фазы на шестнадцатую вперёд">¼ ▶</button>
      </div>
      <div className="tool-row wrap">
        <Segmented<ClockMode> label={t('syncLabel')} value={s.syncMode} onChange={(m) => set({ syncMode: m })} options={syncOptions} />
        <Segmented<4 | 8> label="Длина цикла" value={s.cycleBeats} onChange={(v) => set({ cycleBeats: v })} options={[[8, '8 счётов'], [4, '4 счёта']]} />
      </div>
    </div>
  );
}
