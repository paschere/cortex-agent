import type { Config } from 'tailwindcss';

const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
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
