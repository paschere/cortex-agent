import { ViewStudio } from '@/components/views/ViewStudio';
import { type ToolbarView, ViewToolbar } from '@/components/views/ViewToolbar';
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

  const [sources, versions] = await Promise.all([
    loadViewSources(db, view.spec, { viewerId: user.id }),
    listViewVersions(db, view.id, 20),
  ]);
  const computed = computeView(view.spec, sources, new Date(), {
    writable: canWriteView(view, 'member'),
  });
  const open = view.share_token && shareIsOpen(view) ? publicViewUrl(view.share_token) : null;
  const internal = internalSourcesOf(view.spec);
  const hero = computed.theme?.header === 'hero';

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
    />
  );
  if (editing) return studio;

  return (
    <>
      <Link
        href="/views"
        className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Vistas
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {/* Con la cabecera grande del tema, el título lo pinta el lienzo (ViewHero). */}
        {hero ? (
          <span aria-hidden />
        ) : (
          <div className="min-w-0">
            <h1 className="page-heading text-xl font-bold tracking-tight text-ink">{view.name}</h1>
            {(view.spec.subtitle || view.description) && (
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                {view.spec.subtitle ?? view.description}
              </p>
            )}
          </div>
        )}
        <ViewToolbar
          view={toolbarView}
          versions={versions.map((v) => ({
            version: v.version,
            prompt: v.prompt,
            when: WHEN.format(new Date(v.created_at)),
          }))}
        />
      </header>
      {studio}
    </>
  );
}
