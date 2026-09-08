import { PageHeader } from '@/components/ui/page-header';
import { readFinanceOverview } from '@/lib/finance/overview';
import { readFinanceSources } from '@/lib/finance/sources';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { Landmark } from 'lucide-react';
import { FinanceHub } from './FinanceHub';
import { SourceClassification } from './SourceClassification';

export const dynamic = 'force-dynamic';

export default async function FinancePage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const overview = await readFinanceOverview(db, { userId: user.id });
  const canClassify = user.organization.role === 'owner' || user.organization.role === 'admin';
  const sourceRead = await readFinanceSources(db, { userId: user.id, canClassify })
    .then((result) => ({ result, error: undefined }))
    .catch(() => ({
      result: {
        sources: [],
        summary: {
          unclassified: 0,
          receivableConfirmed: 0,
          payableConfirmed: 0,
          payableByCurrency: [],
        },
        canClassify,
        truncated: false,
      },
      error:
        'El resumen financiero sigue disponible. Reintenta para cargar y clasificar los documentos de esta empresa.',
    }));
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const sources = {
    ...sourceRead.result,
    sources: sourceRead.result.sources.map((source) => ({
      ...source,
      sourceHref: href(source.sourceHref),
    })),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finanzas"
        subtitle="Cartera estimada sobre facturas confirmadas, registros de pago y pendientes que explican cada cifra."
        icon={<Landmark className="h-5 w-5" aria-hidden />}
      />
      <FinanceHub
        overview={overview}
        links={{
          payments: href('/payments'),
          mission: href('/management/mission'),
          integrations: href('/integrations'),
          feed: href('/feed'),
          review: href(
            `/chat?prompt=${encodeURIComponent('Muéstrame las facturas pendientes de confirmar y las que no tienen moneda en esta empresa, con sus fuentes, para revisar su clasificación y sus datos antes de incluirlas en Finanzas.')}`,
          ),
          sources: href('/finance#sources'),
        }}
      />
      <SourceClassification
        key={user.organization.id}
        initial={sources}
        apiHref={href('/api/finance/sources')}
        extractionHref={href(
          `/chat?prompt=${encodeURIComponent('Revisa los documentos de esta empresa que ya están en Conocimiento, extrae los datos de factura con su cita y muéstrame cuáles quedan listos para clasificar en Finanzas.')}`,
        )}
        error={sourceRead.error}
      />
    </div>
  );
}
