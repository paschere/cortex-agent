import { clsx } from 'clsx';

/**
 * LAS ILUSTRACIONES DE UNA APP: dibujos ligeros, propios, sin imágenes externas.
 *
 * Todo está hecho con los tokens del sistema (`primary-soft`, `primary`, `ink`…),
 * así que en una app con marca el dibujo toma el color de la empresa, y en
 * oscuro cambia solo. Son decorativos: `aria-hidden`; el texto que los
 * acompaña dice lo que pasa.
 */

export type IllustrationKind = 'empty' | 'error' | 'offline' | 'lock' | 'done';

export function AppIllustration({
  kind,
  className,
}: {
  kind: IllustrationKind;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorativo; el texto de al lado lo dice todo
    <svg
      viewBox="0 0 160 120"
      fill="none"
      aria-hidden
      className={clsx('h-28 w-auto shrink-0', className)}
    >
      {/* El fondo: una mancha suave y dos puntos, como una hoja de dibujo. */}
      <ellipse cx="80" cy="112" rx="52" ry="5" className="fill-ink/10" />
      <circle cx="80" cy="58" r="48" className="fill-primary-soft" />
      <circle cx="22" cy="30" r="3" className="fill-primary/30" />
      <circle cx="140" cy="86" r="4" className="fill-primary/25" />
      <circle cx="132" cy="24" r="2.5" className="fill-primary/40" />

      {kind === 'empty' && (
        <>
          <rect
            x="44"
            y="30"
            width="72"
            height="62"
            rx="10"
            className="fill-surface stroke-border-strong"
            strokeWidth="2"
          />
          <rect x="54" y="42" width="30" height="6" rx="3" className="fill-primary/50" />
          <rect x="54" y="56" width="52" height="5" rx="2.5" className="fill-ink/15" />
          <rect x="54" y="68" width="40" height="5" rx="2.5" className="fill-ink/15" />
          <circle cx="112" cy="88" r="14" className="fill-primary" />
          <path
            d="M112 82v12M106 88h12"
            className="stroke-surface"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )}

      {kind === 'error' && (
        <>
          <path
            d="M80 28 118 92H42L80 28Z"
            className="fill-surface stroke-rose"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path d="M80 54v18" className="stroke-rose" strokeWidth="4" strokeLinecap="round" />
          <circle cx="80" cy="82" r="2.8" className="fill-rose" />
        </>
      )}

      {kind === 'offline' && (
        <>
          <path
            d="M44 64a52 52 0 0 1 72 0M56 76a34 34 0 0 1 48 0M68 88a17 17 0 0 1 24 0"
            className="stroke-primary/60"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle cx="80" cy="98" r="4" className="fill-primary" />
          <path d="M50 36l60 62" className="stroke-ink" strokeWidth="5" strokeLinecap="round" />
          <path
            d="M50 36l60 62"
            className="stroke-surface"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}

      {kind === 'lock' && (
        <>
          <path
            d="M62 56V46a18 18 0 0 1 36 0v10"
            className="stroke-ink/70"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <rect x="52" y="54" width="56" height="42" rx="11" className="fill-primary" />
          <circle cx="80" cy="72" r="5.5" className="fill-surface" />
          <path d="M80 76v9" className="stroke-surface" strokeWidth="4" strokeLinecap="round" />
        </>
      )}

      {kind === 'done' && (
        <>
          <circle cx="80" cy="58" r="30" className="fill-emerald" />
          <path
            d="m66 59 10 10 19-21"
            className="stroke-surface"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
