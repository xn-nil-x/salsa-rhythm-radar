import { useEffect, useState } from 'react';
import { audioEngine } from '../audio/audio-engine';
import { ALGORITHM_VERSION } from '../audio/analysis-engine';
import { DANCE_PATTERNS } from '../dance/library';
import { t } from '../i18n';
import type { ClaveFamily } from '../rhythm/library';
import type { ClaveDirection } from '../rhythm/types';
import type { AccumDisplay } from '../accumulate/folded';
import { useApp, type FreqScale, type Theme } from '../state/store';
import { Segmented } from './Controls';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function SettingsPanel() {
  const s = useApp((st) => st.settings);
  const set = useApp((st) => st.set);
  const setSpec = useApp((st) => st.setSpec);
  const setDemo = useApp((st) => st.setDemo);
  return (
    <div className="panel">
      <h3>Ритм и танец</h3>
      <Field label="Клаве">
        <div className="row gap">
          <Segmented<ClaveFamily> label="Семейство клаве" value={s.clave.family} onChange={(family) => set({ clave: { ...s.clave, family } })} options={[['son', 'Son'], ['rumba', 'Rumba']]} />
          <Segmented<ClaveDirection> label="Направление клаве" value={s.clave.dir} onChange={(dir) => set({ clave: { ...s.clave, dir } })} options={[['3-2', '3–2'], ['2-3', '2–3']]} />
        </div>
      </Field>
      <Field label="Танцевальная схема">
        <select value={s.dance} onChange={(e) => set({ dance: e.target.value })}>
          {DANCE_PATTERNS.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Накопление наблюдений" hint="Сколько циклов (восьмёрок) помнит радар; старые наблюдения затухают экспоненциально.">
        <Segmented<number> label="Память" value={s.memoryCycles} onChange={(memoryCycles) => set({ memoryCycles })} options={[[1, 'Мгнов.'], [4, '4'], [8, '8'], [16, '16'], [32, '32']]} />
      </Field>
      <Field label="Начало восьмёрки" hint="«1» ищется по совпадению свёрнутого ритма со скелетом сальсы (конга, бас, колокол) с учётом выбранного направления клаве. Кнопка «Здесь 1» отключает автопоиск.">
        <label className="check"><input type="checkbox" checked={s.autoDownbeat} onChange={(e) => set({ autoDownbeat: e.target.checked })} /> {t('autoDownbeat')}</label>
      </Field>
      <Field label="Автоматическая подстройка фазы">
        <label className="check"><input type="checkbox" checked={s.autoPhase} onChange={(e) => set({ autoPhase: e.target.checked })} /> плавная коррекция по найденным долям (PLL)</label>
      </Field>

      <h3>Полярная спектрограмма</h3>
      <Field
        label="Накопление по циклам"
        hint="Мощность: |X|² в одинаковой фазе цикла (устойчиво для перкуссии). Когерентное: комплексное среднее X — остаётся только то, что повторяется с той же формой волны. Когерентность: их отношение, 0…1."
      >
        <Segmented<AccumDisplay> label="Режим накопления" value={s.spec.display} onChange={(display) => setSpec({ display })} options={[['power', 'Мощность'], ['coherent', 'Когерентное'], ['coherence', 'Когерентность']]} />
      </Field>
      <Field label="Шкала частот">
        <Segmented<FreqScale> label="Шкала частот" value={s.spec.scale} onChange={(scale) => setSpec({ scale })} options={[['log', 'Логарифм.'], ['linear', 'Линейная']]} />
      </Field>
      <Field label="Начало оси частот (r₀)" hint="Ноль частоты (или 40 Гц на лог-шкале) начинается не в центре, а на этом радиусе.">
        <Segmented<number> label="Смещение центра" value={s.spec.r0} onChange={(r0) => setSpec({ r0 })} options={[[0, '0'], [0.1, '10%'], [0.2, '20%'], [0.3, '30%']]} />
      </Field>
      <Field label="Верхняя частота">
        <Segmented<number> label="Верхняя частота" value={s.spec.fmax} onChange={(fmax) => setSpec({ fmax })} options={[[2000, '2 кГц'], [5000, '5 кГц'], [10000, '10 кГц']]} />
      </Field>
      <Field label="Динамический диапазон">
        <Segmented<number> label="Диапазон" value={s.spec.dbRange} onChange={(dbRange) => setSpec({ dbRange })} options={[[40, '40 дБ'], [60, '60 дБ'], [80, '80 дБ']]} />
      </Field>
      <Field label="Ориентиры">
        <label className="check"><input type="checkbox" checked={s.spec.showRings} onChange={(e) => setSpec({ showRings: e.target.checked })} /> кольца клаве и атак вокруг спектра</label>
      </Field>
      <button onClick={() => audioEngine.send({ type: 'resetAccumulators' })}>{t('resetAccum')}</button>

      <h3>Demo (синтетический сигнал)</h3>
      <Field label={`Темп: ${s.demo.bpm} BPM`}>
        <input type="range" min={80} max={240} step={1} value={s.demo.bpm} onChange={(e) => setDemo({ bpm: Number(e.target.value) })} />
      </Field>
      <Field label={`Временные отклонения: ±${s.demo.jitterMs} мс`} hint="Случайный микротайминг ударов (σ).">
        <input type="range" min={0} max={25} step={1} value={s.demo.jitterMs} onChange={(e) => setDemo({ jitterMs: Number(e.target.value) })} />
      </Field>
      <Field label={`Пропущенные удары: ${Math.round(s.demo.dropProb * 100)}%`}>
        <input type="range" min={0} max={0.4} step={0.05} value={s.demo.dropProb} onChange={(e) => setDemo({ dropProb: Number(e.target.value) })} />
      </Field>
      <Field label="Шум">
        <Segmented<number> label="Шум" value={s.demo.noiseDb} onChange={(noiseDb) => setDemo({ noiseDb })} options={[[-120, 'Нет'], [-40, '−40 дБ'], [-30, '−30 дБ'], [-20, '−20 дБ']]} />
      </Field>
      <Field label={`Громкость: ${Math.round(s.demo.volume * 100)}%`}>
        <input type="range" min={0} max={1} step={0.05} value={s.demo.volume} onChange={(e) => setDemo({ volume: Number(e.target.value) })} />
      </Field>
      <p className="hint">Звучат видимые эталонные слои инструментов.</p>

      <h3>Интерфейс</h3>
      <Field label="Тема">
        <Segmented<Theme> label="Тема" value={s.theme} onChange={(theme) => set({ theme })} options={[['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']]} />
      </Field>
      <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())}>{t('fullscreen')}</button>
    </div>
  );
}

const LEVEL: Record<string, string> = { reliable: 'надёжно', likely: 'вероятно', weak: 'неуверенно', none: 'нет ритма' };

export function DiagnosticsPanel() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 400);
    return () => clearInterval(id);
  }, []);
  const snap = audioEngine.latest;
  const lat = audioEngine.latencyInfo();
  if (!snap || !lat) return <div className="panel"><p className="muted">Нет данных: запустите источник.</p></div>;
  const tr = snap.tracker;
  const st = snap.stats;
  const load = st.msPerSecondOfAudio / 10; // % of real time
  return (
    <div className="panel diag">
      <h3>Аудио</h3>
      <dl>
        <dt>Частота дискретизации</dt><dd>{lat.sampleRate} Гц</dd>
        <dt>Задержки (base / output)</dt><dd>{(lat.base * 1000).toFixed(1)} / {(lat.output * 1000).toFixed(1)} мс</dd>
        <dt>Получено сэмплов</dt><dd>{st.samplesIn.toLocaleString('ru')}</dd>
        <dt>Нагрузка анализа</dt><dd>{load.toFixed(1)}% реального времени</dd>
        <dt>RMS</dt><dd>{(20 * Math.log10(st.rms + 1e-9)).toFixed(1)} дБFS</dd>
        <dt>Энергия по диапазонам</dt><dd>{st.bandEnergyDb.map((d) => d.toFixed(0)).join(' / ')} дБ (низ/сред/верх)</dd>
        <dt>Атак (низ/сред/верх/все)</dt><dd>{st.onsetCounts.join(' / ')}</dd>
      </dl>
      <h3>Темп и фаза</h3>
      <dl>
        <dt>Часы</dt><dd>{snap.clock.mode} · {snap.clock.bpm.toFixed(2)} BPM · сдвиг {snap.clock.offset.toFixed(2)} доли</dd>
        <dt>Трекер</dt><dd>{tr.locked ? 'захвачен' : 'поиск'} · {tr.bpm.toFixed(2)} BPM</dd>
        <dt>Уверенность</dt><dd>{LEVEL[tr.level]} <span className="muted">(сводно {(tr.confidence * 100).toFixed(0)}%)</span></dd>
        <dt>Чёткость ритма</dt><dd>×{tr.sharpness.toFixed(1)} <span className="muted">чётче шума (1 — ритма нет, ≥6 — надёжно)</span></dd>
        <dt>Отрыв от 2-й гипотезы</dt><dd>×{Number.isFinite(tr.margin) ? tr.margin.toFixed(2) : '∞'} <span className="muted">(≥1,6 — надёжно)</span></dd>
        <dt>Гипотезы темпа</dt>
        <dd>
          {tr.candidates.map((c, i) => (
            <span key={i} className={`cand ${i === 0 ? 'best' : ''}`}>{c.bpm.toFixed(1)} (×{c.score.toFixed(1)})</span>
          ))}
        </dd>
        <dt>Фаза долей</dt><dd>{tr.phaseMethod === 'template' ? 'по рисунку сальсы' : 'по гребёнке долей'} · доля/«&» ×{tr.phaseStrength.toFixed(2)}</dd>
        <dt>Сходство с сальсой</dt><dd>r = {tr.templateR.toFixed(2)} <span className="muted">(шаблон используется при r ≥ 0,35)</span></dd>
        <dt>«1»</dt><dd>{tr.downbeat === 'auto' ? 'автоматически (по рисунку)' : tr.downbeat === 'user' ? 'задана вручную' : 'автопоиск выключен'}</dd>
        {tr.refPhaseErrorMs !== null && (
          <>
            <dt>Ошибка фазы vs эталон</dt><dd>{tr.refPhaseErrorMs.toFixed(1)} мс</dd>
            <dt>Ошибка BPM vs эталон</dt><dd>{tr.refBpmError?.toFixed(2)}</dd>
          </>
        )}
      </dl>
      <h3>Накопление</h3>
      <dl>
        <dt>Циклов в спектрограмме</dt><dd>{snap.cycles}</dd>
        <dt>Сетка спектрограммы</dt><dd>{snap.specAngleBins} × {snap.specFreqBins} (Δf = {snap.specBinHz.toFixed(1)} Гц)</dd>
        <dt>Версия алгоритма</dt><dd className="mono">{ALGORITHM_VERSION}</dd>
      </dl>
    </div>
  );
}
