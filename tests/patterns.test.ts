import { describe, expect, it } from 'vitest';
import { PATTERNS, getPattern, patternPhases, validatePattern } from '../src/rhythm/library';
import { DANCE_PATTERNS } from '../src/dance/library';

const counts = (id: string, clave: '3-2' | '2-3') =>
  patternPhases(getPattern(id)!, clave).map((e) => 1 + e.phase * 8);

describe('reference rhythm library', () => {
  it('every pattern is valid and documented', () => {
    for (const p of PATTERNS) {
      expect(validatePattern(p), p.id).toEqual([]);
      expect(p.source.length, p.id).toBeGreaterThan(10);
    }
    expect(new Set(PATTERNS.map((p) => p.id)).size).toBe(PATTERNS.length);
  });

  it('son clave 3-2 is 1, 2&, 4 | 6, 7', () => {
    expect(counts('son-clave-3-2', '3-2')).toEqual([1, 2.5, 4, 6, 7]);
  });

  it('rumba clave moves the third stroke to 4&', () => {
    expect(counts('rumba-clave-3-2', '3-2')).toEqual([1, 2.5, 4.5, 6, 7]);
  });

  it('2-3 claves are the 3-2 claves rotated by one bar', () => {
    for (const fam of ['son', 'rumba']) {
      const a = counts(`${fam}-clave-3-2`, '3-2').map((c) => ((c - 1 + 4) % 8) + 1).sort((x, y) => x - y);
      expect(counts(`${fam}-clave-2-3`, '2-3')).toEqual(a);
    }
  });

  it('clave-dependent patterns follow the chosen direction', () => {
    // Cáscara is written 2-3; asking for 3-2 rotates it by a bar.
    const c23 = counts('timbales-cascara-2-3', '2-3');
    const c32 = counts('timbales-cascara-2-3', '3-2');
    expect(c23).toEqual([1, 2, 3, 3.5, 4.5, 5, 6, 6.5, 7.5, 8.5]);
    expect(c32.slice(0, 5)).toEqual([1, 2, 2.5, 3.5, 4.5]);
  });

  it('cáscara contains the clave strokes of the same direction except one', () => {
    for (const dir of ['3-2', '2-3'] as const) {
      const cas = new Set(counts('timbales-cascara-2-3', dir));
      const clave = counts(dir === '3-2' ? 'son-clave-3-2' : 'son-clave-2-3', dir);
      expect(clave.filter((c) => !cas.has(c)).length).toBe(1);
    }
  });

  it('bass tumbao plays on 2& and 4 of each bar', () => {
    expect(counts('bass-tumbao', '3-2')).toEqual([2.5, 4, 6.5, 8]);
  });

  it('conga tumbao has slap on 2 and open tones on 4, 4&', () => {
    const p = getPattern('conga-tumbao-basic')!;
    const strong = patternPhases(p, '3-2').filter((e) => e.stroke !== 'heel' && e.stroke !== 'toe');
    expect(strong.map((e) => [1 + e.phase * 8, e.stroke])).toEqual([
      [2, 'slap'], [4, 'open'], [4.5, 'open'], [6, 'slap'], [8, 'open'], [8.5, 'open'],
    ]);
  });
});

describe('dance library', () => {
  it('On1 breaks on 1 and 5, On2 on 2 and 6, both pause on 4 and 8', () => {
    const on1 = DANCE_PATTERNS.find((d) => d.id === 'salsa-on1')!;
    const on2 = DANCE_PATTERNS.find((d) => d.id === 'salsa-on2-et')!;
    expect(on1.events.filter((e) => e.type === 'break').map((e) => e.count)).toEqual([1, 5]);
    expect(on2.events.filter((e) => e.type === 'break').map((e) => e.count)).toEqual([2, 6]);
    for (const d of [on1, on2]) expect(d.events.filter((e) => e.type === 'pause').map((e) => e.count)).toEqual([4, 8]);
  });
});
