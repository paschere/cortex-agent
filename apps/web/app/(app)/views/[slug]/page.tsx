import { ViewStudio } from '@/components/views/ViewStudio';
import { type ToolbarView, ViewToolbar } from '@/components/views/ViewToolbar';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { loadSessionBrand } from '@/lib/branding/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  canWriteView,
  computeView,
  getView,
  internalShareRefusal,
  internalSourcesOf,
  listViewVersions,
  loadViewSources,
  publicViewUrl,
  shareIsOpen,
} from '@cortex/agent-tools';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

/**
 * Una vista, adentro. Los datos se calculan en cada visita con el handle del
 * espacio; lo que llega al navegador es sólo lo que los bloques piden. La
 * barra de abajo la cambia hablando; «Editar» (`?editar=1`) abre el estudio
 * en pantalla completa para cambiarla con las manos; la barra de arriba decide
 * quién más la ve. Con el estudio abierto no se pinta la cabecera: el estudio
 * la tapa entera y trae su propio «Compartir», con los mismos datos.
 *
 * La portada (logo, título, «en vivo», la barra de la vista) la pinta el
 * lienzo; la marca de la empresa (migración 0170) llega por contexto y, si la
 * tabla no contesta, la vista se ve con los colores de Cortex.
 */

export const dynamic = 'force-dynamic';

const WHEN = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

export default async function ViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ editar?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const editing = query.editar === '1';
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, decodeURIComponent(slug));
  if (!view) notFound();

  const [sources, versions, brand] = await Promise.all([
    loadViewSources(db, view.spec, { viewerId: user.id }),
    listViewVersions(db, view.id, 20),
    loadSessionBrand(db, user.organization.name),
  ]);
  const computed = computeView(view.spec, sources, new Date(), {
    writable: canWriteView(view, 'member'),
  });
  const open = view.share_token && shareIsOpen(view) ? publicViewUrl(view.share_token) : null;
  const internal = internalSourcesOf(view.spec);

  const toolbarView: ToolbarView = {
    id: view.id,
    name: view.name,
    version: view.version,
    visibility: view.visibility,
    pinned: view.pinned,
    publicUrl: open,
    expiresAt: view.share_expires_at,
    opens: view.share_views,
    canManage: user.role === 'org_admin' || view.created_by === user.id,
    shareBlocked: internal.length ? internalShareRefusal(internal) : null,
  };
  const toolbar = (
    <ViewToolbar
      view={toolbarView}
      versions={versions.map((v) => ({
        version: v.version,
        prompt: v.prompt,
        when: WHEN.format(new Date(v.created_at)),
      }))}
    />
  );
  const studio = (
    <ViewStudio
      key={view.version}
      view={{
        id: view.id,
        slug: view.slug,
        version: view.version,
        name: view.name,
        description: view.description,
        spec: view.spec,
      }}
      initial={computed}
      share={toolbarView}
      headerActions={editing ? undefined : toolbar}
    />
  );
  if (editing) return <ViewBrandProvider brand={brand}>{studio}</ViewBrandProvider>;

  return (
    <ViewBrandProvider brand={brand}>
      <Link
        href="/views"
        className="view-no-print mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Vistas
      </Link>
      {studio}
    </ViewBrandProvider>
  );
}
