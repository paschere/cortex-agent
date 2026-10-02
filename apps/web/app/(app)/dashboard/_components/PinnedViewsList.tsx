import { ViewCanvas } from '@/components/views/ViewCanvas';
import { BrandScope, ViewBrandProvider } from '@/components/views/blocks/brand';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedView } from '@cortex/agent-tools';
import { ArrowUpRight, LayoutPanelTop } from 'lucide-react';
import Link from 'next/link';

/**
 * EL DIBUJO DE LAS VISTAS FIJADAS, sin lecturas (las hace PinnedViews.tsx).
 *
 * Separado para que el escaparate de desarrollo (/v/welcome-tour) lo pinte
 * con vistas inventadas. Con marca, todo —el icono del título y el lienzo— va
 * dentro de `.cortex-brand`: la empresa ve sus vistas en sus colores también
 * en el Inicio, no sólo al abrirlas. Sin marca, el índigo de siempre.
 */

export interface PinnedEntry {
  view: { id: string; slug: string; name: string };
  computed: ComputedView;
  /** Bloques que no caben en el Inicio. */
  hidden: number;
}

export function PinnedViewsList({
  entries,
  brand,
}: {
  entries: PinnedEntry[];
  brand: ViewBrand | null;
}) {
  if (!entries.length) return null;
  return (
    <ViewBrandProvider brand={brand}>
      <BrandScope className="mb-4 space-y-4">
        {entries.map((entry) => (
          <section key={entry.view.id} aria-labelledby={`pinned-${entry.view.id}`}>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h2
                id={`pinned-${entry.view.id}`}
                className="flex items-center gap-2 text-sm font-semibold text-ink"
              >
                <LayoutPanelTop className="h-4 w-4 text-primary" aria-hidden />
                {entry.view.name}
              </h2>
              <Link
                href={`/views/${entry.view.slug}`}
                className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
              >
                {entry.hidden > 0 ? `Ver completa (+${entry.hidden})` : 'Abrir'}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <ViewCanvas view={entry.computed} target={{ kind: 'preview' }} />
          </section>
        ))}
      </BrandScope>
    </ViewBrandProvider>
  );
}
