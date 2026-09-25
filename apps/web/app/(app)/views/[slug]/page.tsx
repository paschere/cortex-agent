import { ViewStudio } from '@/components/views/ViewStudio';
import { ViewToolbar } from '@/components/views/ViewToolbar';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
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
 * barra de abajo la cambia hablando; la de arriba decide quién más la ve.
 */

export const dynamic = 'force-dynamic';

const WHEN = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

export default async function ViewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, decodeURIComponent(slug));
  if (!view) notFound();

  const [sources, versions] = await Promise.all([
    loadViewSources(db, view.spec),
    listViewVersions(db, view.id, 20),
  ]);
  const computed = computeView(view.spec, sources);
  const open = view.share_token && shareIsOpen(view) ? publicViewUrl(view.share_token) : null;
  const internal = internalSourcesOf(view.spec);

  return (
    <>
      <Link
        href="/views"
        className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Vistas
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="page-heading text-xl font-bold tracking-tight text-ink">{view.name}</h1>
          {(view.spec.subtitle || view.description) && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
              {view.spec.subtitle ?? view.description}
            </p>
          )}
        </div>
        <ViewToolbar
          view={{
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
          }}
          versions={versions.map((v) => ({
            version: v.version,
            prompt: v.prompt,
            when: WHEN.format(new Date(v.created_at)),
          }))}
        />
      </header>
      <ViewStudio
        key={view.version}
        view={{ id: view.id, slug: view.slug, version: view.version }}
        initial={computed}
      />
    </>
  );
}
