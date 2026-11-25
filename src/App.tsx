import { useEffect, useState } from 'react';
import { audioEngine } from './audio/audio-engine';
import { t } from './i18n';
import { useApp } from './state/store';
import { applySettings } from './ui/controller';
import { FileTransport, PhaseBar, Segmented, SourceBar, TempoTools } from './ui/Controls';
import { InfoSheet } from './ui/InfoSheet';
import { LayerList } from './ui/LayerList';
import { DiagnosticsPanel, SettingsPanel } from './ui/Panels';
import { Radar } from './ui/Radar';
import { Footwork } from './ui/Footwork';
import { useResolvedDark } from './ui/theme';
import type { ViewMode } from './state/store';

function useEngineBridge() {
  useEffect(() => {
    // Push settings changes to the running engine.
    const unsubSettings = useApp.subscribe((st, prev) => {
      if (st.settings !== prev.settings) applySettings(prev.settings, st.settings);
    });
    // Low-rate copy of the tracker state for React (the dial reads snapshots directly).
    let last = 0;
    const unsubSnap = audioEngine.onSnapshot((s) => {
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      useApp.getState().ui({ stats: { bpm: s.clock.bpm, confidence: s.tracker.confidence, locked: s.tracker.locked, mode: s.clock.mode, level: s.tracker.level, sharpness: s.tracker.sharpness } });
    });
    return () => {
      unsubSettings();
      unsubSnap();
    };
  }, []);
}

function Header() {
  const running = useApp((s) => s.running);
  const stats = useApp((s) => s.stats);
  const source = useApp((s) => s.settings.source);
  const subtitle = source === 'live' ? 'Микрофон: анализ в реальном времени' : source === 'file' ? 'Анализ аудиофайла' : 'Demo: синтетические рисунки';
  let bpmText = '—';
  let note = t('bpm');
  let tone = '';
  if (running) {
    if (stats.mode === 'auto' && !stats.locked) note = t('searching');
    else {
      bpmText = stats.bpm.toFixed(stats.bpm < 100 ? 1 : 0);
      if (stats.mode === 'auto') {
        const lvl = { reliable: t('levelReliable'), likely: t('levelLikely'), weak: t('levelWeak'), none: t('levelNone') }[stats.level];
        note = `${t('bpm')} · ${lvl} · ${t('clarity', { v: stats.sharpness.toFixed(1).replace('.', ',') })}`;
        tone = stats.level === 'reliable' || stats.level === 'likely' ? 'ok' : 'weak';
      } else {
        note = stats.mode === 'reference' ? `${t('bpm')} · ${t('reference')}` : `${t('bpm')} · ${t('manual')}`;
        tone = 'ok';
      }
    }
  }
  return (
    <header className="app-header">
      <div>
        <h1>{t('appTitle')}</h1>
        <div className="muted">{subtitle}</div>
      </div>
      <div className="bpm">
        <div className={`bpm-value ${tone}`}>{bpmText}</div>
        <div className="muted small" title={t('clarityHint')}>{note}</div>
      </div>
    </header>
  );
}

export function App() {
  useResolvedDark();
  useEngineBridge();
  const [beats, setBeats] = useState(0);
  const view = useApp((s) => s.settings.view);
  const showFootwork = useApp((s) => s.settings.showFootwork);
  const set = useApp((s) => s.set);
  const running = useApp((s) => s.running);
  const error = useApp((s) => s.error);
  const panel = useApp((s) => s.panel);
  const ui = useApp((s) => s.ui);

  return (
    <div className="app">
      <main className="card main-card">
        <Header />
        <SourceBar />
        <FileTransport />
        {error && <div className="error" role="alert">{error}</div>}
        {!running && !error && <p className="hint">{t('idle')}</p>}
        <div className="view-switch">
          <Segmented<ViewMode> label="Вид" value={view} onChange={(v) => set({ view: v })} options={[['layers', t('viewLayers')], ['spectrum', t('viewSpectrum')]]} />
          <button className={showFootwork ? 'on' : ''} aria-pressed={showFootwork} onClick={() => set({ showFootwork: !showFootwork })}>👣 {t('footwork')}</button>
        </div>
        <Radar onPhase={setBeats} />
        <PhaseBar beats={beats} />
        {showFootwork && <Footwork />}
      </main>

      <aside className="side">
        <section className="card">
          <TempoTools />
        </section>
        <section className="card">
          <h2>{t('layers')}</h2>
          <LayerList />
          <p className="footnote">{t('footer')}</p>
        </section>
        <section className="card">
          <div className="row gap">
            <button className={panel === 'settings' ? 'on' : ''} onClick={() => ui({ panel: panel === 'settings' ? 'none' : 'settings' })}>{t('settings')}</button>
            <button className={panel === 'diagnostics' ? 'on' : ''} onClick={() => ui({ panel: panel === 'diagnostics' ? 'none' : 'diagnostics' })}>{t('diagnostics')}</button>
          </div>
          {panel === 'settings' && <SettingsPanel />}
          {panel === 'diagnostics' && <DiagnosticsPanel />}
        </section>
      </aside>
      <InfoSheet />
    </div>
  );
}
