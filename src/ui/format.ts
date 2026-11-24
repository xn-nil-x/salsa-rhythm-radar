/** "1", "1e", "1&", "1a" — musical count name of a position given in beats from count 1. */
export function countName(beats: number, cycleBeats = 8): string {
  const q = Math.round(beats * 4); // nearest sixteenth
  const n = (((Math.floor(q / 4) % cycleBeats) + cycleBeats) % cycleBeats) + 1;
  return `${n}${['', 'e', '&', 'a'][((q % 4) + 4) % 4]}`;
}

/** Counts of a pattern, bars separated: "1, 2&, 4 | 6, 7". */
export function countsList(phases: number[]): string {
  const bar1: string[] = [];
  const bar2: string[] = [];
  for (const p of phases) {
    const beats = p * 8;
    (beats < 4 - 1e-6 ? bar1 : bar2).push(countName(beats));
  }
  return bar2.length ? `${bar1.join(', ')} | ${bar2.join(', ')}` : bar1.join(', ');
}

export const fmtHz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} кГц` : `${Math.round(f)} Гц`);
