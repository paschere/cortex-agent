import type { ViewBrand } from '@/lib/branding/shape';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { computeView, listPinnedViews, loadViewSources } from '@cortex/agent-tools';
import { type PinnedEntry, PinnedViewsList } from './PinnedViewsList';

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
 *
 * Con la marca de la empresa (la lee la página una vez y la pasa): las
 * fijadas se ven en sus colores, como al abrirlas. El dibujo vive en
 * PinnedViewsList.tsx.
 */

const MAX_BLOCKS_ON_HOME = 6;

export async function PinnedViews({
  organizationId,
  viewerId,
  brand,
}: {
  organizationId: string;
  /** Quién mira: las fuentes personales y las del Feed leen SUS filas. */
  viewerId: string;
  /** La marca de la empresa, o null para el índigo de Cortex. */
  brand: ViewBrand | null;
}) {
  const db = getOrgScopedClient(organizationId);
  const pinned = await listPinnedViews(db, 3).catch(() => []);
  if (!pinned.length) return null;

  const computed = await Promise.all(
    pinned.map(async (view): Promise<PinnedEntry | null> => {
      try {
        const full = computeView(view.spec, await loadViewSources(db, view.spec, { viewerId }));
        const blocks = full.blocks.filter((b) => b.type !== 'form').slice(0, MAX_BLOCKS_ON_HOME);
        return {
          view: { id: view.id, slug: view.slug, name: view.name },
          computed: { ...full, blocks },
          hidden: full.blocks.length - blocks.length,
        };
      } catch {
        return null;
      }
    }),
  );

  return (
    <PinnedViewsList entries={computed.filter((e): e is PinnedEntry => e !== null)} brand={brand} />
  );
}
