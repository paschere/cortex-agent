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
        // Tailwind's stock `sm` is 2px, which is a hairline chamfer — a leftover
        // from the squared direction wherever it appears. The design system
        // says small radius is 10px, so `rounded-sm` is bound to the token that
        // actually carries that value.
        sm: 'var(--radius-sm)',
        pill: '999px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Reach for this on anything the user might check, quote or copy.
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        // For the small uppercase labels that name a field on a form.
        field: '0.12em',
      },
      /**
       * THE SCALE, AND WHY THERE WAS NOT ONE.
       *
       * This block did not exist, and that single omission is the whole
       * explanation for what the app looked like: 23 different arbitrary sizes
       * across 1.849 uses of `text-[Npx]`, against 56 of the named scale. It
       * was never a discipline problem — colours have tokens right above and
       * there is not one raw hex in the entire app. There was simply nothing to
       * reach for, so every component invented its own size, and the three
       * commonest were 12.5px, 12px and 13px: a difference nobody can see that
       * still had to be decided, separately, hundreds of times.
       *
       * Seven steps, and they take Tailwind's own names on purpose. A house
       * scale that hides behind `text-body-sm` while `text-sm` still resolves
       * to something else is two scales. The 56 existing uses shift by at most
       * one pixel, which is the cost of having one.
       *
       * Each value carries its line-height, so a component gets a whole type
       * setting from one class rather than remembering to pair `leading-`.
       */
      fontSize: {
        /** Labels, timestamps, evidence. Uppercase ones pair with tracking-field. */
        micro: ['11px', { lineHeight: '1.45' }],
        /** The workhorse: secondary text, table cells, most of the chrome. */
        xs: ['12.5px', { lineHeight: '1.5' }],
        /** Body text and anything somebody reads a paragraph of. */
        sm: ['13px', { lineHeight: '1.6' }],
        /** Emphasis inside a card; the name of the thing you are looking at. */
        base: ['15px', { lineHeight: '1.5' }],
        /** Section heading. */
        lg: ['19px', { lineHeight: '1.35' }],
        /** Page heading. */
        xl: ['22px', { lineHeight: '1.25' }],
        /** One per screen at most, and most screens have none. */
        display: ['32px', { lineHeight: '1.15' }],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};

export default config;
