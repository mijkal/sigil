import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'sigil_theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'auto' ? undefined : theme;
  if (resolved) {
    document.documentElement.setAttribute('data-theme', resolved);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    return saved ?? 'auto';
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved && saved !== 'auto') return saved as 'light' | 'dark';
    return getSystemTheme();
  });

  useEffect(() => {
    applyTheme(theme);
    setResolvedTheme(theme === 'auto' ? getSystemTheme() : theme);
  }, [theme]);

  // Track system theme changes when in auto mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      if (theme === 'auto') setResolvedTheme(getSystemTheme());
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  };

  const toggle = () => {
    // auto → dark → light → auto
    setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto');
  };

  return { theme, resolvedTheme, setTheme, toggle };
}
