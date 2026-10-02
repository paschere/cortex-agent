'use client';

import { PageHeader } from '@/components/ui/page-header';
import { type FinanceDashboard as Data, financeContext } from '@/lib/finance/dashboard-shape';
import { Landmark } from 'lucide-react';
import type { ReactNode } from 'react';
import { AskFinance } from './AskFinance';
import { CashToday } from './CashToday';
import { DueSection } from './DueSection';
import { EmptyFinance } from './EmptyFinance';
import { ForecastSection } from './ForecastSection';
import { PnlSection } from './PnlSection';
import { RecurringSection } from './RecurringSection';
import { ScenarioSection } from './ScenarioSection';
import type { FinanceActions, FinanceLinks } from './types';

/**
 * EL PANEL DE FINANZAS: caja de hoy, las 13 semanas que vienen, los «¿y
 * si…?», cómo va el mes, quién debe y a quién se le debe, lo fijo, y al final
 * los documentos por clasificar (`documents`, que pinta la página).
 *
 * Todo lo que se cambia pasa por `actions` (la página real pasa las del
 * servidor; el escaparate, unas de mentira) y todo lo que se pide de más se
 * pide a Cortex con la caja de arriba.
 */
export function FinanceDashboard({
  data,
  links,
  actions,
  documents,
}: {
  data: Data;
  links: FinanceLinks;
  actions: FinanceActions;
  documents?: ReactNode;
}) {
  const params = {
    includeEstimatedSales: data.includeEstimatedSales,
    minimumCash: data.minimumCash,
  };
  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          title="Finanzas"
          subtitle="Tu caja de hoy, si te alcanza las próximas 13 semanas y cómo va el mes. Lo que no veas aquí, pídeselo a Cortex."
          icon={<Landmark className="h-5 w-5" aria-hidden />}
        />
        <div className="-mt-3">
          <AskFinance chat={links.chat} context={financeContext(data)} />
        </div>
      </div>

      {data.empty ? (
        <EmptyFinance links={links} />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(300px,1fr)_minmax(0,2.1fr)]">
            <CashToday
              cash={data.cash}
              isAdmin={data.isAdmin}
              actions={actions}
              bankImport={links.bankImport}
            />
            <ForecastSection
              forecast={data.forecast}
              self={links.self}
              scenarioId={data.activeScenarioId}
              {...params}
              companyMinimumCash={data.companyMinimumCash}
              saveMinimumCash={data.canSaveMinimum ? actions.saveMinimumCash : undefined}
            />
          </div>
          <ScenarioSection
            scenarios={data.scenarios}
            activeId={data.activeScenarioId}
            self={links.self}
            chat={links.chat}
            params={params}
            today={data.today}
            currency={data.currency}
            counterparties={data.counterparties}
            actions={actions}
          />
          <PnlSection pnl={data.pnl} />
          <DueSection due={data.due} payments={links.payments} chat={links.chat} />
          <RecurringSection
            recurring={data.recurring}
            isAdmin={data.isAdmin}
            currency={data.currency}
            actions={actions}
          />
        </>
      )}

      {documents}
    </div>
  );
}
