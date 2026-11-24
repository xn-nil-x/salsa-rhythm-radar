import { getDancePattern } from '../dance/library';
import { t } from '../i18n';
import { useApp } from '../state/store';
import { LAYERS, patternForLayer } from '../viz/layers';

export function LayerList() {
  const s = useApp((st) => st.settings);
  const toggle = useApp((st) => st.toggleLayer);
  const ui = useApp((st) => st.ui);
  return (
    <ul className="layer-list">
      {LAYERS.map((l) => {
        const on = s.visible[l.id];
        const name = l.id === 'clave' ? patternForLayer(l, s.clave)?.name ?? l.label : l.kind === 'dance' ? getDancePattern(s.dance)?.name ?? l.label : l.label;
        const kind = l.kind === 'reference' ? t('kindReference') : l.kind === 'observed' ? t('kindObserved') : t('kindDance');
        return (
          <li key={l.id} className={on ? '' : 'off'}>
            <label>
              <input type="checkbox" checked={on} onChange={() => toggle(l.id)} />
              <span className={`dot ${l.kind}`} style={l.kind === 'observed' ? undefined : { background: l.color }} />
              <span className="name">{name}</span>
            </label>
            <button className="kind" onClick={() => ui({ info: { kind: 'layer', id: l.id } })} title="Подробнее">
              {kind}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
