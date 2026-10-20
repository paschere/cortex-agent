import { DraftInbox, type DraftView } from '@/components/prefacturas/DraftInbox';
import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type InvoiceDraftStatus, isCompanyManager, listInvoiceDrafts } from '@cortex/agent-tools';
import { Receipt } from 'lucide-react';

/**
 * PREFACTURAS POR REVISAR (migración 0230): lo que las automatizaciones
 * dejaron armado al cerrarse una atención. Nada de aquí está en Siigo hasta
 * que una persona aprueba.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Prefacturas por revisar · Cortex' };

const OPEN: InvoiceDraftStatus[] = ['pending', 'error', 'creating'];

export default async function PrefacturasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const canReview = await isCompanyManager(db, user.id).catch(() => false);
  const [open, done] = canReview
    ? await Promise.all([
        listInvoiceDrafts(db, { statuses: OPEN, limit: 100 }).catch(() => null),
        listInvoiceDrafts(db, { statuses: ['created', 'discarded'], limit: 30 }).catch(() => []),
      ])
    : [[], []];
  const view = (d: NonNullable<typeof open>[number]): DraftView => ({ ...d });
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Prefacturas por revisar"
        subtitle="Las armó una automatización cuando se cerró una atención. Revísalas, corrige lo que haga falta y apruébalas: sólo entonces se crean en Siigo."
        icon={<Receipt className="h-5 w-5" aria-hidden />}
      />
      {!canReview ? (
        <p className="rounded-sm bg-surface-2 px-3 py-2 text-sm text-ink-muted">
          Sólo quien administra la empresa revisa las prefacturas.
        </p>
      ) : open === null ? (
        <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-sm text-rose">
          No se pudieron leer las prefacturas. Si es la primera vez, falta aplicar la migración 0230.
        </p>
      ) : (
        <DraftInbox
          open={open.map(view)}
          done={done.map(view)}
          focusId={typeof q.abrir === 'string' ? q.abrir : null}
        />
      )}
    </div>
  );
}
