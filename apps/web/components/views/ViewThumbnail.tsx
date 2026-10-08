import { clsx } from 'clsx';
import { blockIcon } from './editor/block-meta';

/**
 * LA MINIATURA DE UNA VISTA: su forma, no sus datos.
 *
 * Un esquema de la rejilla —cada bloque en su ancho y con un trazo que dice
 * qué es: barras para un gráfico, renglones para una tabla, columnas para un
 * tablero— para reconocer una vista de un vistazo sin calcularla. Calcular
 * sesenta vistas para pintar la lista costaría sesenta lecturas de hasta
 * 2.000 filas; el spec ya dice todo lo que la miniatura necesita.
 *
 * La lista de /views la usa grande (`size="lg"`): cada pieza lleva además el
 * icono de su tipo y todo se tiñe con el acento de la vista, para que dos
 * tableros con la misma forma no se confundan. La galería de plantillas y la
 * biblioteca del estudio reusan `BlockGlyph` para dibujar una pieza suelta.
 *
 * Decorativa (`aria-hidden`): el nombre y los tipos de bloque ya están en
 * texto en la tarjeta.
 */

const SPAN: Record<string, string> = {
  full: 'col-span-6',
  half: 'col-span-3',
  third: 'col-span-2',
};

/** Clases completas por acento: Tailwind sólo genera lo que ve escrito. */
const TONE = {
  primary: {
    bar: 'bg-primary/60',
    soft: 'bg-primary/15 ring-primary/25',
    ink: 'text-primary',
    wash: 'from-primary/10',
  },
  emerald: {
    bar: 'bg-emerald/60',
    soft: 'bg-emerald/15 ring-emerald/25',
    ink: 'text-emerald',
    wash: 'from-emerald/10',
  },
  amber: {
    bar: 'bg-amber/60',
    soft: 'bg-amber/15 ring-amber/25',
    ink: 'text-amber',
    wash: 'from-amber/10',
  },
  sky: { bar: 'bg-sky/60', soft: 'bg-sky/15 ring-sky/25', ink: 'text-sky', wash: 'from-sky/10' },
  rose: {
    bar: 'bg-rose/60',
    soft: 'bg-rose/15 ring-rose/25',
    ink: 'text-rose',
    wash: 'from-rose/10',
  },
} as const;

export type ThumbnailTone = keyof typeof TONE;

export function toneOf(accent: unknown): ThumbnailTone {
  return typeof accent === 'string' && accent in TONE ? (accent as ThumbnailTone) : 'primary';
}

const BARS = [55, 80, 40, 95, 65, 75];

/** El dibujo de una pieza: lo que la distingue de las demás a 40 px de alto. */
export function BlockGlyph({
  type,
  tone = 'primary',
  large = false,
}: {
  type: string;
  tone?: ThumbnailTone;
  large?: boolean;
}) {
  const t = TONE[tone];
  switch (type) {
    case 'metric':
    case 'kpi':
    case 'trend':
      return (
        <div className={clsx('flex flex-col justify-center gap-1 px-1.5', large ? 'h-9' : 'h-6')}>
          <span className="h-0.5 w-1/2 rounded-pill bg-ink-faint/40" />
          <span className={clsx('h-1.5 w-3/4 rounded-pill', t.bar)} />
          {type !== 'metric' && (
            <svg viewBox="0 0 40 8" className={clsx('h-2 w-full', t.ink)} aria-hidden="true">
              <title>Tendencia</title>
              <polyline
                points="0,7 8,5 16,6 24,3 32,4 40,1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          )}
        </div>
      );
    case 'progress':
      return (
        <div className={clsx('flex flex-col justify-center gap-1 px-1.5', large ? 'h-9' : 'h-6')}>
          <span className="h-0.5 w-1/2 rounded-pill bg-ink-faint/40" />
          <span className="h-1.5 w-full overflow-hidden rounded-pill bg-ink-faint/20">
            <span className={clsx('block h-full w-2/3 rounded-pill', t.bar)} />
          </span>
        </div>
      );
    case 'chart':
      return (
        <div className={clsx('flex items-end gap-0.5 px-1.5 pb-1', large ? 'h-14' : 'h-10')}>
          {BARS.map((h) => (
            <span
              key={h}
              className={clsx('flex-1 rounded-t-pill', t.bar)}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      );
    case 'table':
      return (
        <div className={clsx('flex flex-col justify-center gap-1 px-1.5', large ? 'h-14' : 'h-12')}>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={clsx(
                'h-0.5 rounded-pill',
                i === 0 ? 'bg-ink-faint/60' : 'bg-ink-faint/30',
              )}
            />
          ))}
        </div>
      );
    case 'board':
    case 'zones':
      return (
        <div
          className={clsx(
            'grid gap-0.5 p-1',
            large ? 'h-14' : 'h-12',
            type === 'zones' ? 'grid-cols-3 grid-rows-2' : 'grid-cols-4',
          )}
        >
          {Array.from({ length: type === 'zones' ? 6 : 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: casillas fijas de un dibujo.
            <span key={i} className={clsx('rounded-sm ring-1 ring-inset', t.soft)} />
          ))}
        </div>
      );
    case 'gallery':
    case 'media':
    case 'image':
      return (
        <div
          className={clsx(
            'grid gap-0.5 p-1',
            large ? 'h-14' : 'h-12',
            type === 'gallery' ? 'grid-cols-3' : 'grid-cols-1',
          )}
        >
          {Array.from({ length: type === 'gallery' ? 3 : 1 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: casillas fijas de un dibujo.
            <span key={i} className={clsx('rounded-sm ring-1 ring-inset', t.soft)} />
          ))}
        </div>
      );
    case 'cards':
    case 'detail':
      return (
        <div
          className={clsx(
            'grid gap-0.5 p-1',
            large ? 'h-14' : 'h-12',
            type === 'cards' ? 'grid-cols-2' : 'grid-cols-3',
          )}
        >
          {Array.from({ length: type === 'cards' ? 4 : 3 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: casillas fijas de un dibujo.
              key={i}
              className={clsx(
                'rounded-sm ring-1 ring-inset',
                i === 2 && type === 'detail' ? 'row-span-1 bg-ink-faint/20' : t.soft,
              )}
            />
          ))}
        </div>
      );
    case 'map':
      return (
        <div
          className={clsx(
            'relative overflow-hidden rounded-sm bg-surface-2',
            large ? 'h-14' : 'h-12',
          )}
        >
          {[
            ['18%', '30%'],
            ['52%', '58%'],
            ['74%', '24%'],
          ].map(([left, top]) => (
            <span
              key={`${left}${top}`}
              className={clsx('absolute h-2 w-2 rounded-pill', t.bar)}
              style={{ left, top }}
            />
          ))}
        </div>
      );
    case 'calendar':
      return (
        <div className={clsx('grid grid-cols-7 gap-px p-1', large ? 'h-14' : 'h-12')}>
          {Array.from({ length: 21 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: casillas fijas de un dibujo.
              key={i}
              className={clsx('rounded-pill', i === 9 || i === 15 ? t.bar : 'bg-ink-faint/20')}
            />
          ))}
        </div>
      );
    case 'links':
      return (
        <div className={clsx('flex flex-col justify-center gap-1 px-1.5', large ? 'h-9' : 'h-6')}>
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className={clsx('h-1 w-1 rounded-pill', t.bar)} />
              <span className="h-0.5 flex-1 rounded-pill bg-ink-faint/40" />
            </span>
          ))}
        </div>
      );
    case 'form':
      return (
        <div className={clsx('flex flex-col justify-center gap-1 px-1.5', large ? 'h-12' : 'h-10')}>
          <span className="h-1.5 rounded-sm bg-surface ring-1 ring-border-strong" />
          <span className="h-1.5 rounded-sm bg-surface ring-1 ring-border-strong" />
          <span className={clsx('h-1.5 w-1/3 rounded-pill', t.bar)} />
        </div>
      );
    default:
      return (
        <div className={clsx('flex flex-col justify-center gap-0.5 px-1.5', large ? 'h-7' : 'h-5')}>
          <span className="h-1 w-2/5 rounded-pill bg-ink-faint/60" />
          <span className="h-0.5 w-4/5 rounded-pill bg-ink-faint/30" />
        </div>
      );
  }
}

export function ViewThumbnail({
  blocks,
  accent,
  size = 'sm',
  className,
}: {
  blocks: Array<{ type: string; width: string }>;
  accent?: unknown;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const tone = toneOf(accent);
  const large = size === 'lg';
  return (
    <div
      aria-hidden
      className={clsx(
        'grid grid-cols-6 content-start gap-1 overflow-hidden rounded-sm ring-1 ring-inset ring-border',
        large
          ? clsx('h-40 gap-1.5 bg-gradient-to-br to-canvas/70 p-2.5', TONE[tone].wash)
          : 'max-h-28 bg-canvas/60 p-1.5',
        className,
      )}
    >
      {blocks.slice(0, large ? 12 : 10).map((b, i) => {
        const Icon = blockIcon(b.type);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: miniatura fija; el orden es la identidad.
            key={i}
            className={clsx(
              'relative min-w-0 rounded-pill',
              SPAN[b.width] ?? SPAN.full,
              b.type === 'text' ? 'bg-transparent' : 'bg-surface-2 ring-1 ring-inset ring-border',
              large && b.type !== 'text' && 'bg-surface shadow-card',
            )}
          >
            {large && b.type !== 'text' && (
              <Icon className={clsx('absolute right-1 top-1 h-2.5 w-2.5', TONE[tone].ink)} />
            )}
            <BlockGlyph type={b.type} tone={tone} large={large} />
          </div>
        );
      })}
    </div>
  );
}
