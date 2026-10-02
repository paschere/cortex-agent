import { Panel } from '@/components/ui/panel';
import { buildAccountingCards, canManageAccounting } from '@/lib/accounting/card';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AccountingConnectionRow,
  accountingTableSpec,
  getAccountingProvider,
  listAccountingConnections,
  listAccountingProviders,
} from '@cortex/agent-tools';
import { Calculator } from 'lucide-react';
import { AccountingProviderCard } from './AccountingProviderCard';

/**
 * PROGRAMAS CONTABLES (migración 0165): una tarjeta por programa. Siigo y
 * Alegra se conectan pegando su llave aquí; QuickBooks, entrando a Intuit (y
 * si la instalación no tiene su app configurada, la tarjeta lo dice). El ancla
 * `#programas-contables` es a donde llevan el autoservicio y los avisos.
 *
 * Sólo para quien administra el espacio: pegar la llave de la contabilidad de
 * la empresa es una decisión de la empresa. Los demás no ven la sección.
 */
export async function AccountingSection({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  // Quien no administra no ve las llaves, pero sí que la sección existe y a
  // quién pedírsela: una pantalla que calla lo que no te deja hacer es un
  // callejón sin salida.
  if (!canManageAccounting(role)) {
    return (
      <Panel className="mb-5 flex flex-wrap items-center gap-3 p-4" id="programas-contables">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
          <Calculator className="h-4 w-4" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">
            Programas contables (Siigo, Alegra, QuickBooks).
          </span>{' '}
          Los conecta quien administra la empresa en Cortex; si los necesitas, pídeselo.
        </p>
      </Panel>
    );
  }
  const db = getOrgScopedClient(organizationId);
  let connections: AccountingConnectionRow[] = [];
  let readError = false;
  try {
    connections = await listAccountingConnections(db);
  } catch {
    readError = true;
  }
  const cards = buildAccountingCards(
    listAccountingProviders(),
    connections,
    (provider, entity) =>
      accountingTableSpec(
        getAccountingProvider(provider.id) ?? { id: provider.id, name: provider.name },
        entity,
      ).slug,
  );

  return (
    <Panel className="mb-5 scroll-mt-5 p-5" id="programas-contables">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
          <Calculator className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="field-label">Sólo administradores</div>
          <h2 className="mt-0.5 text-base font-bold tracking-tight text-ink">
            Programas contables
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
            Conecta el programa de contabilidad de la empresa una sola vez y Cortex trae solo tus
            clientes, productos, facturas y pagos a tablas que puedes ver, filtrar y usar en vistas.
            Las facturas con saldo entran a la cartera y a la plata en riesgo.
          </p>
        </div>
      </div>
      {readError && (
        <p className="mt-4 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-xs text-amber">
          No se pudo leer el estado de las conexiones. Si conectaste un programa, sigue conectado;
          vuelve a cargar la página en un momento.
        </p>
      )}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {cards.map((card) => (
          <AccountingProviderCard key={card.provider.id} card={card} />
        ))}
      </div>
    </Panel>
  );
}
