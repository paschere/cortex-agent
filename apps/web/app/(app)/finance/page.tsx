import { PageHeader } from '@/components/ui/page-header';
import { readFinanceOverview } from '@/lib/finance/overview';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import { Landmark } from 'lucide-react';
import { FinanceHub } from './FinanceHub';

export const dynamic = 'force-dynamic';

export default async function FinancePage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const overview = await readFinanceOverview(db, { userId: user.id });
  const href = (path: string) => workspaceHref(user.organization.id, path);

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
            `/chat?prompt=${encodeURIComponent('Muéstrame las facturas pendientes de confirmar de esta empresa, con sus fuentes, para revisarlas antes de incluirlas en Finanzas.')}`,
          ),
        }}
      />
    </div>
  );
}
