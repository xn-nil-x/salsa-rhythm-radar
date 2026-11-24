import { audioEngine } from '../audio/audio-engine';
import { CHANNEL_ALL } from '../audio/analysis-engine';
import { getDancePattern } from '../dance/library';
import { t } from '../i18n';
import { matchPattern } from '../rhythm/matching';
import { patternPhases } from '../rhythm/library';
import { useApp } from '../state/store';
import { CHANNEL_BANDS, LAYER_BY_ID, patternForLayer } from '../viz/layers';
import { countName, countsList, fmtHz } from './format';

const STATUS: Record<string, string> = {
  established: 'широко документирован',
  simplified: 'упрощённый вариант',
  illustrative: 'иллюстративный пример',
};

const DANCE_TYPE: Record<string, string> = {
  step: 'шаг', break: 'брейк (смена направления)', tap: 'касание без переноса', pause: 'пауза', turn: 'вращение', vertical: 'вертикальный акцент',
};
const DIR: Record<string, string> = { forward: 'вперёд', back: 'назад', side: 'вбок', diagonal: 'диагонально', 'in-place': 'на месте' };

export function InfoSheet() {
  const info = useApp((s) => s.info);
  const s = useApp((st) => st.settings);
  const ui = useApp((st) => st.ui);
  if (!info) return null;
  const snap = audioEngine.latest;
  let body: React.ReactNode = null;
  let title = '';

  if (info.kind === 'spec') {
    title = 'Полярная спектрограмма';
    body = (
      <>
        <p className="kind-badge observed">{t('kindObserved')}</p>
        <dl>
          <dt>Частота</dt><dd>≈ {fmtHz(info.freq)}</dd>
          <dt>Позиция в цикле</dt><dd>{countName(info.phase * 8, s.cycleBeats)}</dd>
          <dt>Режим</dt><dd>{s.spec.display === 'power' ? 'мощность, фазо-синхронное усреднение' : s.spec.display === 'coherent' ? 'когерентное (комплексное) накопление' : 'когерентность |ΣX|² / Σ|X|²'}</dd>
          <dt>Накоплено циклов</dt><dd>{snap?.cycles ?? 0} (память {s.memoryCycles})</dd>
        </dl>
        <p className="muted small">Яркость — энергия спектра в этой фазе цикла, усреднённая по циклам с экспоненциальным забыванием. Частота не указывает на конкретный инструмент.</p>
      </>
    );
  } else {
    const layer = LAYER_BY_ID[info.id];
    title = layer.label;
    if (layer.kind === 'reference') {
      const p = patternForLayer(layer, s.clave);
      if (p) {
        title = p.name;
        const ev = patternPhases(p, s.clave.dir);
        const all = snap ? snap.density.subarray(CHANNEL_ALL * snap.densityBins, (CHANNEL_ALL + 1) * snap.densityBins) : null;
        const hasData = all && all.some((v) => v > 0);
        const m = hasData ? matchPattern(ev, all) : null;
        body = (
          <>
            <p className="kind-badge reference">{t('kindReference')} — не измерение</p>
            <dl>
              <dt>Традиция</dt><dd>{p.tradition}</dd>
              <dt>Инструмент</dt><dd>{p.instrument}</dd>
              <dt>Удары</dt><dd className="mono">{countsList(ev.map((e) => e.phase))}</dd>
              <dt>Направление клаве</dt><dd>{p.clave ? `записан для ${p.clave}, показан для ${s.clave.dir}` : 'не зависит'}</dd>
              <dt>Статус</dt><dd>{STATUS[p.status]}</dd>
              <dt>Источник</dt><dd className="small">{p.source}</dd>
              {p.notes && (<><dt>Примечание</dt><dd className="small">{p.notes}</dd></>)}
              {p.variants && (<><dt>Варианты</dt><dd className="small">{p.variants.join('; ')}</dd></>)}
            </dl>
            <h4>Сравнение с наблюдением</h4>
            {m ? (
              <p className="small">
                Корреляция с накопленными атаками (все диапазоны): <b>r = {m.r0.toFixed(2)}</b> в текущей фазе; лучшая <b>{m.rBest.toFixed(2)}</b> при сдвиге{' '}
                {(m.lagBest * s.cycleBeats).toFixed(2)} счёта. Это статистика совпадения ритма, а не распознавание инструмента.
              </p>
            ) : (
              <p className="small muted">Нет накопленных наблюдений.</p>
            )}
          </>
        );
      }
    } else if (layer.kind === 'observed') {
      const ch = layer.channel ?? 3;
      body = (
        <>
          <p className="kind-badge observed">{t('kindObserved')}</p>
          <dl>
            <dt>Диапазон</dt><dd>{CHANNEL_BANDS[ch]}</dd>
            <dt>Данные</dt><dd>атаки (пики спектрального потока), накопленные в музыкальной фазе без квантизации</dd>
            <dt>Атак обнаружено</dt><dd>{snap?.stats.onsetCounts[ch] ?? 0}</dd>
            <dt>Память</dt><dd>{s.memoryCycles <= 1 ? 'только текущий цикл' : `≈ ${s.memoryCycles} циклов, экспоненциальное забывание`}</dd>
            <dt>Синхронизация</dt><dd>{snap ? (snap.clock.mode === 'auto' ? (snap.tracker.locked ? `авто, уверенность ${Math.round(snap.tracker.confidence * 100)}%` : 'темп не найден — фаза недостоверна') : snap.clock.mode === 'reference' ? 'эталонный темп Demo' : 'ручная') : '—'}</dd>
          </dl>
          <p className="muted small">Прозрачность кольца отражает уверенность синхронизации: без захвата темпа положение атак в цикле не имеет смысла.</p>
        </>
      );
    } else {
      const d = getDancePattern(s.dance);
      if (d) {
        title = d.name;
        body = (
          <>
            <p className="kind-badge dance">{t('kindDance')} — не измерение движений</p>
            <dl>
              <dt>Традиция</dt><dd>{d.tradition}</dd>
              <dt>Статус</dt><dd>{STATUS[d.status]}</dd>
              <dt>Источник</dt><dd className="small">{d.source}</dd>
              {d.notes && (<><dt>Примечание</dt><dd className="small">{d.notes}</dd></>)}
            </dl>
            <table className="events">
              <thead><tr><th>Счёт</th><th>Событие</th><th>Нога</th><th>Направление</th></tr></thead>
              <tbody>
                {d.events.map((e) => (
                  <tr key={e.count}><td>{e.count}</td><td>{DANCE_TYPE[e.type]}</td><td>{e.foot ?? '—'}</td><td>{DIR[e.direction]}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        );
      }
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => ui({ info: null })}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="row between">
          <h3>{title}</h3>
          <button onClick={() => ui({ info: null })} aria-label={t('close')}>✕</button>
        </header>
        {body}
      </section>
    </div>
  );
}
