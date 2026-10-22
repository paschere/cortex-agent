import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  ACCOUNTING_SOURCE_KINDS,
  ACCOUNTING_SOURCE_KIND_LABEL,
  listAccountingSources,
  listTrackers,
  originsOf,
} from '@cortex/agent-tools';
import {
  previewAccountingSource,
  removeAccountingSourceAction,
  saveAccountingSourceAction,
} from '../accounting-sources-actions';
import { AccountingSourcesPanel } from './AccountingSourcesPanel';

/**
 * FUENTES CONTABLES COMBINADAS (0239), debajo de las tarjetas de los programas
 * contables. Sólo para quien administra: declarar una hoja como fuente cambia
 * las cifras de Cartera, Por pagar, resultados y Hoy.
 */
export async function AccountingSourcesSection({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);
  const [sources, trackers] = await Promise.all([
    listAccountingSources(db).catch(() => []),
    listTrackers(db, 200).catch(() => []),
  ]);
  // Las tablas que llena el programa contable ya alimentan las cifras: no se ofrecen.
  const tables = trackers
    .filter((t) => !originsOf(t).some((o) => o.kind === 'accounting'))
    .map((t) => ({ slug: t.slug, name: t.name }));
  return (
    <AccountingSourcesPanel
      sources={sources.map((s) => ({
        id: s.id,
        origin: s.origin,
        kindLabel: ACCOUNTING_SOURCE_KIND_LABEL[s.kind],
        tableName: s.trackerName,
        precedence: s.precedence,
        enabled: s.enabled,
      }))}
      tables={tables}
      kinds={ACCOUNTING_SOURCE_KINDS.map((k) => ({
        kind: k,
        label: ACCOUNTING_SOURCE_KIND_LABEL[k],
      }))}
      actions={{
        preview: previewAccountingSource,
        save: saveAccountingSourceAction,
        remove: removeAccountingSourceAction,
      }}
    />
  );
}
