import type { SupabaseClient } from '@supabase/supabase-js';
import { listAccountingConnections } from '../accounting/store';
import { getClosePeriod } from './lock';
import type { ClosePdfInput } from './pdf';
import { type AutoCheck, type TaskStatus, periodEnd, periodStart, taskReady } from './shape';
import { computeClose } from './store';
import {
  PROVIDER_LABEL,
  WRITEBACK_KIND_LABEL,
  type WritebackKind,
  type WritebackProvider,
} from './writeback/shape';

/**
 * Lo que va en el PDF del cierre (0192): la foto guardada al cerrar, o la
 * revisión de este momento si el mes sigue abierto, y lo que Cortex registró
 * en el programa con fecha del mes. `names` traduce ids de personas.
 */
export async function loadCloseReport(
  db: SupabaseClient,
  period: string,
  names: ReadonlyMap<string, string>,
): Promise<ClosePdfInput> {
  const row = await getClosePeriod(db, period);
  const view = await computeClose(db, period);
  const summary = (row?.summary ?? {}) as {
    note?: string | null;
    tasks?: Array<{
      title: string;
      status: TaskStatus;
      auto: AutoCheck;
      evidence: string | null;
      doneBy: string | null;
    }>;
  };
  const tasks =
    row?.status === 'cerrado' && Array.isArray(summary.tasks)
      ? summary.tasks.map((t) => ({
          title: t.title,
          status: t.status,
          ready: taskReady({ key: '', status: t.status, auto: t.auto }),
          detail: t.auto?.detail ?? '',
          evidence: t.evidence,
          doneByName: t.doneBy ? (names.get(t.doneBy) ?? null) : null,
        }))
      : view.tasks.map((t) => ({
          title: t.title,
          status: t.status,
          ready: t.ready,
          detail: t.auto.detail,
          evidence: t.evidence,
          doneByName: t.doneBy ? (names.get(t.doneBy) ?? null) : null,
        }));

  const { data, error } = await db
    .from('accounting_writebacks')
    .select('kind, amount, provider')
    .eq('status', 'registrada')
    .gte('doc_date', periodStart(period))
    .lte('doc_date', periodEnd(period))
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    kind: WritebackKind;
    amount: number | string | null;
    provider: string;
  }>;
  const kinds: WritebackKind[] = ['compra', 'recibo', 'pago_proveedor'];
  const connections = await listAccountingConnections(db).catch(() => []);
  const provider = (rows[0]?.provider ??
    connections.find((c) => c.enabled)?.provider ??
    null) as WritebackProvider | null;
  return {
    label: view.label,
    status: view.status,
    closedAt: row?.closed_at ?? null,
    closedByName: row?.closed_by ? (names.get(row.closed_by) ?? null) : null,
    note: summary.note ?? null,
    progress: { done: tasks.filter((t) => t.ready).length, total: tasks.length },
    tasks,
    writebacks: kinds.map((k) => {
      const of = rows.filter((r) => r.kind === k);
      return {
        label: WRITEBACK_KIND_LABEL[k],
        count: of.length,
        amount: of.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      };
    }),
    providerName: provider ? (PROVIDER_LABEL[provider] ?? null) : null,
    generatedAt: new Date().toISOString(),
  };
}
