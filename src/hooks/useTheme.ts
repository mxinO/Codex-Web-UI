import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

function readInitialTheme(): Theme {
  try {
    const storedTheme = window.localStorage.getItem('theme');
    return storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'dark';
  } catch {
    return 'dark';
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('theme', theme);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }, [theme]);

  return { theme, setTheme };
}
