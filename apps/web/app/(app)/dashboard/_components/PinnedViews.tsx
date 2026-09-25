import { ViewCanvas } from '@/components/views/ViewCanvas';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ComputedView,
  computeView,
  listPinnedViews,
  loadViewSources,
} from '@cortex/agent-tools';
import { ArrowUpRight, LayoutPanelTop } from 'lucide-react';
import Link from 'next/link';

/**
 * LAS VISTAS FIJADAS, EN INICIO.
 *
 * Inicio es «lo que te espera», no un tablero (ver la cabecera de page.tsx), y
 * esto no lo contradice: aquí sólo aparece lo que alguien del equipo FIJÓ a
 * propósito, como quien pega una hoja en la pared. Sin vistas fijadas no se
 * pinta nada, ni un hueco que invite a llenarlo.
 *
 * Se muestra la vista sin sus formularios (en Inicio se mira, no se captura) y
 * con un tope de bloques, para que una vista larga no empuje todo lo demás
 * fuera de la pantalla. La vista entera está a un clic.
 *
 * Va en su propio Suspense en la página: leer las filas de tres vistas no
 * puede demorar lo que ya estaba listo arriba.
 */

const MAX_BLOCKS_ON_HOME = 6;

export async function PinnedViews({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);
  const pinned = await listPinnedViews(db, 3).catch(() => []);
  if (!pinned.length) return null;

  const computed = await Promise.all(
    pinned.map(async (view) => {
      try {
        const full = computeView(view.spec, await loadViewSources(db, view.spec));
        const blocks = full.blocks.filter((b) => b.type !== 'form').slice(0, MAX_BLOCKS_ON_HOME);
        return {
          view,
          computed: { ...full, blocks } satisfies ComputedView,
          hidden: full.blocks.length - blocks.length,
        };
      } catch {
        return null;
      }
    }),
  );

  return (
    <div className="mb-4 space-y-4">
      {computed.map((entry) =>
        entry ? (
          <section key={entry.view.id} aria-labelledby={`pinned-${entry.view.id}`}>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h2
                id={`pinned-${entry.view.id}`}
                className="flex items-center gap-2 text-sm font-semibold text-ink"
              >
                <LayoutPanelTop className="h-4 w-4 text-primary" />
                {entry.view.name}
              </h2>
              <Link
                href={`/views/${entry.view.slug}`}
                className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
              >
                {entry.hidden > 0 ? `Ver completa (+${entry.hidden})` : 'Abrir'}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <ViewCanvas view={entry.computed} target={{ kind: 'preview' }} />
          </section>
        ) : null,
      )}
    </div>
  );
}
