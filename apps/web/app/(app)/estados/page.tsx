import { StatementsScreen } from '@/components/statements/StatementsScreen';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  EXPENSE_CLASSES,
  EXPENSE_CLASS_LABEL,
  INCOME_LINE_META,
  accountingProviderLabel,
  bogotaToday,
  isCompanyManager,
  loadStatements,
} from '@cortex/agent-tools';
import { refreshStatementsAction, saveClassesAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * ESTADOS FINANCIEROS (0191). Cualquiera de la empresa los ve (la nómina, con
 * detalle sólo para quien administra); traer del programa contable y cambiar
 * la clasificación de gastos lo hace quien administra o es dueño.
 *
 * Parámetros: `?anio=2026&mes=9`.
 */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const q = await searchParams;
  const num = (k: string) => (typeof q[k] === 'string' ? Number(q[k]) : Number.NaN);
  const year = num('anio');
  const month = num('mes');
  const [data, canEdit] = await Promise.all([
    loadStatements(db, {
      today: bogotaToday(),
      viewerId: user.id,
      year: Number.isFinite(year) ? year : undefined,
      throughMonth: Number.isFinite(month) ? month : undefined,
    }),
    isCompanyManager(db, user.id),
  ]);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  return (
    <StatementsScreen
      data={data}
      lines={[...INCOME_LINE_META]}
      classLabels={{ ...EXPENSE_CLASS_LABEL }}
      classKeys={[...EXPENSE_CLASSES]}
      providerLabel={
        data.accounting.provider ? accountingProviderLabel(data.accounting.provider) : null
      }
      canEdit={canEdit}
      links={{
        self: href('/estados'),
        budget: href('/presupuesto'),
        board: href('/informe-socios'),
        finance: href('/finance'),
        integrations: href('/integrations#programas-contables'),
        chat: href('/chat'),
      }}
      actions={{ refresh: refreshStatementsAction, saveClasses: saveClassesAction }}
    />
  );
}
