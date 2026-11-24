import { useEffect, useState } from 'react';
import { useApp } from '../state/store';

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** True when the effective theme is dark (explicit choice or system preference). */
export function useResolvedDark(): boolean {
  const theme = useApp((s) => s.settings.theme);
  const [sysDark, setSysDark] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const q = query();
    if (!q) return;
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  const dark = theme === 'dark' || (theme === 'auto' && sysDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return dark;
}
