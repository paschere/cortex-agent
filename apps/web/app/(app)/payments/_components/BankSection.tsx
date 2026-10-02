import { Panel } from '@/components/ui/panel';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type ReconItem, type SuggestionView, bankReconciliation } from '@cortex/agent-tools';
import { BankStatements } from './BankStatements';
import type { BankReconView, ReconItemView, SuggestionChoice } from './bank-types';
import { money, shortDate } from './format';

/**
 * La conciliación del banco, del lado del servidor.
 *
 * Componente de servidor aparte para que la página no cargue con su consulta:
 * lee lo que entró por los extractos, lo pasa por el emparejador contra las
 * facturas abiertas de ESTE momento (`bankReconciliation`) y le entrega al
 * navegador sólo conclusiones con las cifras ya escritas.
 */

function choice(s: SuggestionView): SuggestionChoice {
  return { kind: s.kind, id: s.id, label: s.label, reasons: s.reasons, exact: s.exact };
}

function view(item: ReconItem): ReconItemView {
  return {
    paymentId: item.paymentId,
    date: shortDate(item.date),
    amount: money(item.amount, item.currency),
    description: item.description,
    reference: item.reference,
    account: item.account,
    client: item.client,
    invoiceNumber: item.invoiceNumber,
    status: item.status,
    reason: item.reason,
    suggestions: item.suggestions.map(choice),
    currency: item.currency,
  };
}

export async function BankSection({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);
  let recon: BankReconView;
  try {
    const r = await bankReconciliation(db);
    recon = {
      matched: r.matched.slice(0, 50).map(view),
      suggested: r.suggested.map(view),
      unmatched: r.unmatched.map(view),
      accounts: r.accounts,
      openInvoices: r.openInvoices.map((s) => ({ ...choice(s), currency: s.currency })),
    };
  } catch {
    return (
      <Panel id="extractos" className="scroll-mt-20 px-5 py-6">
        <p className="text-sm text-ink-muted">
          No se pudo cargar la conciliación del banco ahora mismo. Recarga la página en un momento.
        </p>
      </Panel>
    );
  }
  // El ancla `#extractos`: Finanzas y la guía mandan aquí para importar uno.
  return (
    <div id="extractos" className="scroll-mt-20">
      <BankStatements recon={recon} />
    </div>
  );
}
