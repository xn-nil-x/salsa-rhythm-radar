import { useEffect, useRef } from 'react';
import { footworkAt } from '../dance/footwork';
import { getDancePattern, type DanceEvent } from '../dance/library';
import { useApp } from '../state/store';
import { displayClock } from './display-clock';

const FOOT = 'M0,-26 C9,-26 13,-15 12,-3 C11,9 9,19 6,24 C3,28 -3,28 -6,24 C-9,19 -11,9 -12,-3 C-13,-15 -9,-26 0,-26 Z';
const LANE = 26; // half distance between feet, px
const STEP = 36; // one step forward/back, px
const CX = 78;
const CY = 82;

const DIR: Record<string, string> = { forward: 'вперёд', back: 'назад', together: 'приставить', 'in-place': 'на месте', side: 'в сторону', diagonal: 'по диагонали' };
const FOOTNAME = { L: 'левая', R: 'правая' } as const;

function describe(ev: DanceEvent | null): string {
  if (!ev) return '';
  if (ev.type === 'pause') return 'пауза';
  const who = ev.foot ? FOOTNAME[ev.foot] : 'шаг';
  return `${who} ${DIR[ev.direction] ?? ''}${ev.type === 'break' ? ' · брейк' : ''}`.trim();
}

/** Animated top-down view of the leader's feet for the selected dance scheme. */
export function Footwork() {
  const danceId = useApp((s) => s.settings.dance);
  const pattern = getDancePattern(danceId);
  const refs = {
    L: useRef<SVGGElement>(null),
    R: useRef<SVGGElement>(null),
    LGlow: useRef<SVGPathElement>(null),
    RGlow: useRef<SVGPathElement>(null),
    LBody: useRef<SVGPathElement>(null),
    RBody: useRef<SVGPathElement>(null),
    count: useRef<SVGTextElement>(null),
    action: useRef<SVGTextElement>(null),
    next: useRef<SVGTextElement>(null),
    any: useRef<SVGCircleElement>(null),
    cells: useRef<SVGGElement>(null),
  };

  useEffect(() => {
    if (!pattern) return;
    let raf = 0;
    let lastText = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const b = displayClock.beats;
      const st = footworkAt(pattern, b);
      for (const f of ['L', 'R'] as const) {
        const v = st[f];
        const x = CX + (f === 'L' ? -LANE : LANE) + v.pos.x * LANE;
        const y = CY + v.pos.y * STEP;
        refs[f].current?.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
        const glow = refs[f === 'L' ? 'LGlow' : 'RGlow'].current;
        if (glow) {
          glow.style.opacity = v.flash.toFixed(3);
          glow.setAttribute('class', `foot-glow ${v.flashType === 'break' ? 'break' : ''}`);
        }
        refs[f === 'L' ? 'LBody' : 'RBody'].current?.setAttribute('class', `foot-body ${v.weight ? 'weight' : ''}`);
      }
      if (refs.any.current) refs.any.current.style.opacity = (pattern.events.some((e) => e.foot) ? 0 : st.anyFlash).toFixed(3);
      const count = Math.floor(st.cyclePos) + 1;
      const text = `${count}|${describe(st.current)}|${describe(st.next)}`;
      if (text !== lastText) {
        lastText = text;
        if (refs.count.current) refs.count.current.textContent = String(count);
        if (refs.action.current) refs.action.current.textContent = describe(st.current);
        if (refs.next.current) refs.next.current.textContent = st.next ? `далее ${st.next.count}: ${describe(st.next)}` : '';
        refs.cells.current?.querySelectorAll('g[data-c]').forEach((g) => g.setAttribute('class', `fw-cell ${g.getAttribute('data-c') === String(count) ? 'now' : ''}`));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern]);

  if (!pattern) return null;
  const hasFeet = pattern.events.some((e) => e.foot);
  const cellW = 340 / 8;
  return (
    <div className="footwork">
      <svg viewBox="0 0 360 196" role="img" aria-label={`Шаги ведущего: ${pattern.name}`}>
        <text x="4" y="14" className="fw-hint">↑ вперёд</text>
        <line x1={CX} y1={CY - STEP - 30} x2={CX} y2={CY + STEP + 30} className="fw-axis" />
        <line x1={CX - 70} y1={CY} x2={CX + 70} y2={CY} className="fw-axis" />
        <circle ref={refs.any} cx={CX} cy={CY} r="26" className="fw-any" />
        {(['L', 'R'] as const).map((f) => (
          <g key={f} ref={refs[f]} transform={`translate(${CX + (f === 'L' ? -LANE : LANE)},${CY})`} style={{ opacity: hasFeet ? 1 : 0.25 }}>
            <path ref={refs[f === 'L' ? 'LGlow' : 'RGlow']} d={FOOT} className="foot-glow" transform="scale(1.35)" />
            <path ref={refs[f === 'L' ? 'LBody' : 'RBody']} d={FOOT} className="foot-body" transform={f === 'L' ? 'rotate(-6)' : 'rotate(6)'} />
            <text y="5" textAnchor="middle" className="fw-letter">{f}</text>
          </g>
        ))}
        <text ref={refs.count} x="250" y="62" textAnchor="middle" className="fw-count">1</text>
        <text ref={refs.action} x="250" y="92" textAnchor="middle" className="fw-action" />
        <text ref={refs.next} x="250" y="114" textAnchor="middle" className="fw-next" />
        {!hasFeet && <text x="250" y="132" textAnchor="middle" className="fw-next">ноги в схеме не заданы</text>}
        <g ref={refs.cells} transform="translate(10,150)">
          {Array.from({ length: 8 }, (_, i) => {
            const ev = pattern.events.find((e) => e.count === i + 1);
            const label = !ev ? '' : ev.type === 'pause' ? '·' : ev.foot ?? '•';
            return (
              <g key={i} data-c={i + 1} className="fw-cell" transform={`translate(${i * cellW},0)`}>
                <rect width={cellW - 4} height="38" rx="7" className={ev?.type === 'break' ? 'brk' : ''} />
                <text x={(cellW - 4) / 2} y="15" textAnchor="middle" className="fw-cnum">{i + 1}</text>
                <text x={(cellW - 4) / 2} y="31" textAnchor="middle" className="fw-cfoot">{label}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="fw-caption muted small">{pattern.name} · ведущий · эталонная схема, не измерение</div>
    </div>
  );
}
