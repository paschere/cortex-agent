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
        rail: {
          DEFAULT: rgb('--rail'),
          2: rgb('--rail-2'),
          border: rgb('--rail-border'),
          ink: rgb('--rail-ink'),
          'ink-muted': rgb('--rail-ink-muted'),
          'ink-faint': rgb('--rail-ink-faint'),
        },
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
       * EL MOVIMIENTO DE LA PRESENCIA — y por qué vive aquí y no en globals.css.
       *
       * Estos cuatro son el vocabulario de un único componente,
       * `components/chat/Presence.tsx`, que es lo que hay al otro lado de la
       * conversación. Cada uno responde una pregunta distinta y no son
       * intercambiables:
       *
       *   `breathe`  — «sigo aquí». Late aunque no pase nada. Es lo único que
       *                corre en reposo y por eso es el más lento y el más
       *                tenue: un latido que se nota es un latido que cansa a la
       *                tercera hora, y esta pantalla se abre todos los días.
       *   `orbit`    — «estoy haciendo algo ahí fuera». Sólo con una herramienta
       *                en vuelo. Es la única rotación de la app.
       *   `halo`     — «estoy pensando». Un pulso que se expande y se apaga,
       *                sin rotar, porque pensar no es ir a ninguna parte.
       *   `blink`    — «estoy escribiendo». El cursor, y nada más.
       *
       * La regla del sistema de diseño («el movimiento contesta una pregunta,
       * nunca decora») es exactamente lo que impide que sean cinco. Un estado
       * sin movimiento propio es un estado que no hacía falta distinguir.
       *
       * `prefers-reduced-motion` los apaga a los cuatro desde globals.css, que
       * ya pone `animation-duration: .01ms !important` sobre `*` — por eso son
       * animaciones CSS y no JavaScript. Y por eso ninguno de los cinco estados
       * puede depender SÓLO del movimiento para leerse: cada uno cambia también
       * el color o el trazo, o desaparece para quien pidió que nada se moviera.
       */
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '0.55', transform: 'scale(0.88)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
        orbit: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        halo: {
          '0%': { opacity: '0.5', transform: 'scale(0.7)' },
          '70%, 100%': { opacity: '0', transform: 'scale(1.9)' },
        },
        blink: {
          '0%, 45%': { opacity: '1' },
          '55%, 100%': { opacity: '0.15' },
        },
        /**
         * El velo de un diálogo al abrirse.
         *
         * No pertenece a la presencia: está aquí porque los tres diálogos de la
         * app (`ScreenView` dos veces, `TeachFlowDialog`) pedían
         * `data-[state=open]:animate-in fade-in`, que son clases de
         * `tailwindcss-animate` — UN PLUGIN QUE NO ESTÁ INSTALADO NI DECLARADO.
         * Llevaban meses abriéndose de golpe, con un `motion-reduce:animate-none`
         * al lado protegiendo una animación inexistente, y sin un solo error en
         * ninguna parte. Lo encontró `lib/motion-tokens.test.ts`, que existe
         * exactamente para esto.
         */
        veil: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        /**
         * EL FONDO DE LA CONVERSACIÓN. Ver `components/chat/AmbientField.tsx`.
         *
         * Dos recorridos y no uno: tres manchas con la MISMA animación y
         * distinta duración acaban cruzándose en un patrón que el ojo aprende,
         * y en cuanto se aprende se mira. Con dos formas distintas, duraciones
         * primas entre sí y sentidos opuestos, la composición no se repite en
         * toda la sesión.
         *
         * Sólo `transform`: es lo único que el compositor puede mover sin
         * volver a rasterizar, y estas capas van con un desenfoque enorme
         * encima. Animar su opacidad o su tamaño sería repintar media pantalla
         * sesenta veces por segundo para algo que nadie debe llegar a mirar.
         */
        'drift-a': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '33%': { transform: 'translate3d(6%, 4%, 0) scale(1.12)' },
          '66%': { transform: 'translate3d(-4%, 7%, 0) scale(0.94)' },
        },
        'drift-b': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '50%': { transform: 'translate3d(-7%, -5%, 0) scale(1.15)' },
        },
        /**
         * EL BARRIDO. Una banda ancha de luz que cruza la malla, inclinada.
         *
         * La pausa está DENTRO del keyframe y no es un detalle: entre el 55% y
         * el 100% la banda ya salió por la derecha y no se ve. Un barrido
         * continuo es un metrónomo —vuelve cada tantos segundos, el ojo aprende
         * el ritmo y a partir de ahí lo espera—; con casi la mitad del ciclo en
         * negro, lo que se percibe es que de vez en cuando pasa algo, que es lo
         * que se quería decir.
         *
         * `skewX` y no `rotate`: rotar una banda a lo alto de la pantalla obliga
         * a hacerla mucho más larga para que no se le vean las puntas al girar.
         */
        sweep: {
          '0%': { transform: 'translate3d(-60%, 0, 0) skewX(-14deg)' },
          '55%, 100%': { transform: 'translate3d(240%, 0, 0) skewX(-14deg)' },
        },
        /**
         * LA AURORA: un gradiente cónico gigante girando muy despacio.
         *
         * Es lo que separa «moderno» de «tenía un degradado». Un cónico da un
         * color que CAMBIA según el ángulo, así que al girar la luz no se
         * desplaza —eso ya lo hacen las manchas— sino que cambia de tono por
         * zonas, que es lo que hace un cielo y no hace un foco.
         *
         * Cuarenta segundos por vuelta: una revolución entera dura más que la
         * mayoría de las visitas a esta pantalla, así que nadie llega a ver que
         * es un giro.
         */
        aurora: {
          from: { transform: 'rotate(0deg) scale(1.35)' },
          to: { transform: 'rotate(360deg) scale(1.35)' },
        },
      },
      animation: {
        breathe: 'breathe 3.4s ease-in-out infinite',
        orbit: 'orbit 1.4s linear infinite',
        halo: 'halo 2s ease-out infinite',
        blink: 'blink 1.1s ease-in-out infinite',
        veil: 'veil 150ms ease-out',
        // Primos entre sí a propósito: 23 y 31 segundos no vuelven a coincidir
        // hasta pasados doce minutos, que es más de lo que dura una sesión de
        // chat. Y son lentísimos porque esto está detrás de un texto que se lee.
        'drift-a': 'drift-a 23s ease-in-out infinite',
        'drift-b': 'drift-b 31s ease-in-out infinite',
        // 19s, y primo también con los dos anteriores: el barrido no debe
        // coincidir nunca con el mismo sitio de las manchas.
        sweep: 'sweep 19s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        // El MISMO recorrido a un tercio del tiempo, para cuando hay un turno
        // corriendo. No es otro movimiento: es el mismo, con prisa — que es
        // exactamente lo que se quiere decir.
        'sweep-fast': 'sweep 6.5s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        aurora: 'aurora 40s linear infinite',
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
