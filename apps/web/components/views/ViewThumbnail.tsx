import { clsx } from 'clsx';

/**
 * LA MINIATURA DE UNA VISTA EN LA LISTA: su forma, no sus datos.
 *
 * Un esquema de la rejilla —cada bloque en su ancho y con un trazo que dice
 * qué es: barras para un gráfico, renglones para una tabla, columnas para un
 * tablero— para reconocer una vista de un vistazo sin calcularla. Calcular
 * sesenta vistas para pintar la lista costaría sesenta lecturas de hasta
 * 2.000 filas; el spec ya dice todo lo que la miniatura necesita.
 *
 * Decorativa (`aria-hidden`): el nombre y los tipos de bloque ya están en
 * texto en la tarjeta.
 */

const SPAN: Record<string, string> = {
  full: 'col-span-6',
  half: 'col-span-3',
  third: 'col-span-2',
};

function Glyph({ type }: { type: string }) {
  switch (type) {
    case 'metric':
      return (
        <div className="flex h-6 flex-col justify-center gap-1 px-1.5">
          <span className="h-0.5 w-1/2 rounded-pill bg-ink-faint/40" />
          <span className="h-1.5 w-3/4 rounded-pill bg-primary/70" />
        </div>
      );
    case 'chart':
      return (
        <div className="flex h-10 items-end gap-0.5 px-1.5 pb-1">
          {[55, 80, 40, 95, 65, 75].map((h) => (
            <span
              key={h}
              className="flex-1 rounded-t-pill bg-primary/55"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      );
    case 'table':
      return (
        <div className="flex h-12 flex-col justify-center gap-1 px-1.5">
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
            'grid h-12 gap-0.5 p-1',
            type === 'zones' ? 'grid-cols-3 grid-rows-2' : 'grid-cols-4',
          )}
        >
          {Array.from({ length: type === 'zones' ? 6 : 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: casillas fijas de un dibujo.
            <span key={i} className="rounded-sm bg-primary/20 ring-1 ring-inset ring-primary/20" />
          ))}
        </div>
      );
    case 'form':
      return (
        <div className="flex h-10 flex-col justify-center gap-1 px-1.5">
          <span className="h-1.5 rounded-sm bg-surface ring-1 ring-border-strong" />
          <span className="h-1.5 rounded-sm bg-surface ring-1 ring-border-strong" />
          <span className="h-1.5 w-1/3 rounded-pill bg-primary/70" />
        </div>
      );
    default:
      return (
        <div className="flex h-5 flex-col justify-center gap-0.5 px-1.5">
          <span className="h-1 w-2/5 rounded-pill bg-ink-faint/60" />
          <span className="h-0.5 w-4/5 rounded-pill bg-ink-faint/30" />
        </div>
      );
  }
}

export function ViewThumbnail({
  blocks,
  className,
}: {
  blocks: Array<{ type: string; width: string }>;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={clsx(
        'grid max-h-28 grid-cols-6 content-start gap-1 overflow-hidden rounded-sm bg-canvas/60 p-1.5 ring-1 ring-inset ring-border',
        className,
      )}
    >
      {blocks.slice(0, 10).map((b, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: miniatura fija; el orden es la identidad.
          key={i}
          className={clsx(
            'min-w-0 rounded-pill',
            SPAN[b.width] ?? SPAN.full,
            b.type === 'text' ? 'bg-transparent' : 'bg-surface-2 ring-1 ring-inset ring-border',
          )}
        >
          <Glyph type={b.type} />
        </div>
      ))}
    </div>
  );
}
