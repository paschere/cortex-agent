import type { Config } from 'tailwindcss';

const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  // The palette in globals.css is light-only — one token set, `color-scheme:
  // light`, no dark counterpart. Tailwind's default is `darkMode: 'media'`, so
  // any stray `dark:` variant fired off the visitor's OS setting and repainted
  // a surface dark while the text kept inheriting the light-mode ink: black on
  // black, which is how the conversation transcript became unreadable on
  // Windows. Pinning it to `class` means those variants can only apply when
  // something deliberately sets `.dark`, which nothing does yet.
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        canvas: rgb('--canvas'),
        surface: rgb('--surface'),
        'surface-2': rgb('--surface-2'),
        border: rgb('--border'),
        'border-strong': rgb('--border-strong'),
        ink: rgb('--ink'),
        'ink-muted': rgb('--ink-muted'),
        'ink-faint': rgb('--ink-faint'),
        primary: {
          DEFAULT: rgb('--primary'),
          strong: rgb('--primary-strong'),
          soft: rgb('--primary-soft'),
          ink: rgb('--primary-ink'),
        },
        emerald: { DEFAULT: rgb('--emerald'), soft: rgb('--emerald-soft') },
        amber: { DEFAULT: rgb('--amber'), soft: rgb('--amber-soft') },
        sky: { DEFAULT: rgb('--sky'), soft: rgb('--sky-soft') },
        rose: { DEFAULT: rgb('--rose'), soft: rgb('--rose-soft') },
      },
      borderRadius: {
        card: 'var(--radius)',
        pill: '999px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      fontFamily: {
        sans: ['var(--font-jakarta)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};

export default config;
