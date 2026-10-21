import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * El encabezado de cada bloque de «Hoy»: el título en la letra del cuaderno,
 * una línea que dice qué se está mirando y, a la derecha, la pantalla completa
 * de donde sale. Un solo tamaño (el de «sección» de la escala) para toda la
 * página.
 */
export function SectionHead({
  title,
  hint,
  href,
  hrefLabel,
  right,
}: {
  title: string;
  hint?: string;
  href?: string;
  hrefLabel?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <h2 className="font-display text-xl leading-tight text-ink">{title}</h2>
        {hint && <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
      {right}
      {href && (
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40"
        >
          {hrefLabel ?? 'Abrir'}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}
    </div>
  );
}
