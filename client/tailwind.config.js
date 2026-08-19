/** @type {import('tailwindcss').Config} */
// Ported verbatim from public/index.html's inline tailwind.config (rimmy palette over CSS
// custom properties defined in src/index.css) — keep both in sync until index.html is retired.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rimmy: {
          black: 'var(--color-bg)',
          charcoal: 'var(--color-card)',
          purple: 'var(--color-header)',
          purpleHover: 'var(--color-header-hover)',
          orange: 'var(--color-accent)',
          orangeHover: 'var(--color-accent-hover)',
          text: 'var(--color-text)',
          textMuted: 'var(--color-text-muted)',
          border: 'var(--color-border)',
        },
      },
    },
  },
  plugins: [],
};
