// Plain TypeScript, mirrors preferences.ts's style and reuses the same `tb_theme` key that
// client/index.html's pre-paint script and public/index.html's applyTheme() both read/write.
export type Theme = 'dark' | 'light';

const THEME_KEY = 'tb_theme';

export function getTheme(): Theme {
  return (localStorage.getItem(THEME_KEY) as Theme | null) || 'dark';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
