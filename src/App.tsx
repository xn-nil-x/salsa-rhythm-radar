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
      useApp.getState().ui({ stats: { bpm: s.clock.bpm, confidence: s.tracker.confidence, locked: s.tracker.locked, mode: s.clock.mode } });
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
  if (running) {
    if (stats.mode === 'auto' && !stats.locked) note = t('searching');
    else {
      bpmText = stats.bpm.toFixed(stats.bpm < 100 ? 1 : 0);
      note = stats.mode === 'auto' ? `${t('bpm')} · ${t('confidence', { v: Math.round(stats.confidence * 100) })}` : stats.mode === 'reference' ? `${t('bpm')} · ${t('reference')}` : `${t('bpm')} · ${t('manual')}`;
    }
  }
  return (
    <header className="app-header">
      <div>
        <h1>{t('appTitle')}</h1>
        <div className="muted">{subtitle}</div>
      </div>
      <div className="bpm">
        <div className={`bpm-value ${running && (stats.mode !== 'auto' || stats.locked) ? 'ok' : ''}`}>{bpmText}</div>
        <div className="muted small">{note}</div>
      </div>
    </header>
  );
}

export function App() {
  useResolvedDark();
  useEngineBridge();
  const [beats, setBeats] = useState(0);
  const view = useApp((s) => s.settings.view);
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
        </div>
        <Radar onPhase={setBeats} />
        <PhaseBar beats={beats} />
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
