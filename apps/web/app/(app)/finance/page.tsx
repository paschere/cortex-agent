import { FinanceDashboard } from '@/components/finance/FinanceDashboard';
import { statusPill } from '@/components/finance/pieces';
import type { FinanceLinks } from '@/components/finance/types';
import { readFinanceDashboard } from '@/lib/finance/dashboard';
import { readDashboardParams } from '@/lib/finance/dashboard-shape';
import { readFinanceSources } from '@/lib/finance/sources';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { bogotaToday } from '@cortex/agent-tools';
import { ChevronDown, FileSearch } from 'lucide-react';
import { SourceClassification } from './SourceClassification';
import {
  decideRecurringAction,
  declareRecurringAction,
  deleteScenarioAction,
  saveScenarioAction,
  updateBalance,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * FINANZAS: el panel de la plata de la empresa (components/finance), leído
 * en lib/finance/dashboard.ts con cada pieza aislada, y al final, plegados,
 * los documentos por clasificar de siempre.
 *
 * Parámetros: `?escenario=<id>` pinta un escenario guardado encima de la
 * proyección, `?estimadas=1` suma las ventas estimadas y `?minimo=<pesos>`
 * marca la caja mínima.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const params = readDashboardParams(await searchParams);
  // `org_admin` es el rol que la sesión le pone al dueño o admin de la empresa.
  const isAdmin = user.role === 'org_admin';
  const canClassify = user.organization.role === 'owner' || user.organization.role === 'admin';
  const href = (path: string) => workspaceHref(user.organization.id, path);

  const [dashboard, sourceRead] = await Promise.all([
    readFinanceDashboard(db, {
      userId: user.id,
      isAdmin,
      today: bogotaToday(),
      ...params,
    }),
    readFinanceSources(db, { userId: user.id, canClassify })
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
          'El resto de Finanzas sigue disponible. Reintenta para cargar y clasificar los documentos de esta empresa.',
      })),
  ]);

  const sources = {
    ...sourceRead.result,
    sources: sourceRead.result.sources.map((source) => ({
      ...source,
      sourceHref: href(source.sourceHref),
    })),
  };
  const unclassified = sources.summary.unclassified;

  const links: FinanceLinks = {
    self: href('/finance'),
    chat: href('/chat'),
    payments: href('/payments'),
    bankImport: href('/payments#extractos'),
    accounting: href('/integrations#programas-contables'),
  };

  return (
    <FinanceDashboard
      data={dashboard}
      links={links}
      actions={{
        updateBalance,
        saveScenario: saveScenarioAction,
        deleteScenario: deleteScenarioAction,
        declareRecurring: declareRecurringAction,
        decideRecurring: decideRecurringAction,
      }}
      documents={
        <details
          id="documentos"
          className="group scroll-mt-6 rounded-card border border-border bg-surface shadow-card"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 sm:px-6 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-sm bg-primary-soft text-primary">
                <FileSearch className="h-4 w-4" aria-hidden />
              </span>
              <span>
                <span className="block text-lg font-extrabold text-ink">
                  Documentos por clasificar
                </span>
                <span className="block text-xs text-ink-muted">
                  Facturas y documentos leídos: decide cuáles cuentan como por cobrar o por pagar.
                </span>
              </span>
            </span>
            <span className="flex items-center gap-2">
              {unclassified > 0 && (
                <span className={statusPill('amber')}>
                  {unclassified} {unclassified === 1 ? 'pendiente' : 'pendientes'}
                </span>
              )}
              <ChevronDown
                className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
                aria-hidden
              />
            </span>
          </summary>
          <div className="border-t border-border px-5 py-5 sm:px-6">
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
        </details>
      }
    />
  );
}
