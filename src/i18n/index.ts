/**
 * Minimal localisation: one dictionary per language, `t(key, vars)` lookup.
 * Russian is the default; add a language by adding a dictionary with the same keys.
 */
import { ru } from './ru';

export type Dict = typeof ru;
export type Key = keyof Dict;

const dicts: Record<string, Dict> = { ru };
let current: Dict = ru;

export function setLanguage(lang: string): void {
  current = dicts[lang] ?? ru;
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = current[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
