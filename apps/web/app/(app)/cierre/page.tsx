import { CloseScreen } from '@/components/close/CloseScreen';
import type { CloseScreenData, MappingRowView } from '@/components/close/types';
import { loadTeam } from '@/lib/clients/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  ACCOUNT_CATEGORY_DEFAULTS,
  ACCOUNT_ROLE_DEFAULTS,
  ACCOUNT_ROLE_KEYS,
  ACCOUNT_ROLE_LABEL,
  type AccountMapRow,
  CLOSE_TASKS,
  LEDGER_CATEGORIES,
  LEDGER_CATEGORY_LABEL,
  bankRoleKey,
  bogotaToday,
  currentClosePeriod,
  isClosePeriod,
  isCompanyManager,
  listCloseEvents,
  listClosePeriods,
  listSuppliers,
  loadAccountMap,
  loadWritebackQueue,
  reconcileWritebacks,
  refreshClose,
  shiftClosePeriod,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import {
  assignTaskAction,
  closePeriodAction,
  discardWritebackAction,
  markTaskAction,
  openOverrideAction,
  previewWritebackAction,
  registerWritebacksAction,
  reopenPeriodAction,
  resetMappingAction,
  restoreWritebackAction,
  saveMappingAction,
} from './actions';

/**
 * CIERRE DEL MES (0192): la lista guiada del mes que toca cerrar (cada tarea
 * con su revisión automática, su responsable y su evidencia), la cola de lo
 * que Cortex puede registrar en el programa contable (con vista previa y
 * aprobación), el plan de cuentas que usa para escribir y los meses cerrados.
 *
 * Parámetros: `?mes=2026-09`, `?tab=mes|registrar|cuentas|historial`.
 */

export const dynamic = 'force-dynamic';

const TABS = ['mes', 'registrar', 'cuentas', 'historial'] as const;
type Tab = (typeof TABS)[number];

export default async function CierrePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab: Tab = TABS.includes(q.tab as Tab) ? (q.tab as Tab) : 'mes';
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const href = (path: string) => workspaceHref(user.organization.id, path);

  const asked = typeof q.mes === 'string' ? q.mes : '';
  const period = isClosePeriod(asked) ? asked : await currentClosePeriod(db, today);
  const thisMonth = today.slice(0, 7);
  const periods = Array.from({ length: 6 }, (_, i) => shiftClosePeriod(thisMonth, -i));

  // Ponerse al día con el programa: barato e idempotente; si falla, la pantalla sale igual.
  await reconcileWritebacks(db).catch((err) => logger.warn({ err }, 'close: reconcile failed'));

  const [viewRead, queueRead, history, map, suppliers, team, events, canManage, banks] =
    await Promise.all([
      refreshClose(db, period)
        .then((view) => ({ view, error: null as string | null }))
        .catch((err) => ({ view: null, error: toolErrorMessage(err) })),
      loadWritebackQueue(db, { period })
        .then((queue) => ({ queue, error: null as string | null }))
        .catch((err) => ({ queue: null, error: toolErrorMessage(err) })),
      listClosePeriods(db).catch(() => []),
      loadAccountMap(db).catch(() => null),
      listSuppliers(db).catch(() => []),
      loadTeam(db).catch(() => []),
      listCloseEvents(db, period, 30).catch(() => []),
      isCompanyManager(db, user.id).catch(() => false),
      db
        .from('ledger_accounts')
        .select('name')
        .eq('source_kind', 'bank')
        .limit(50)
        .then(({ data, error }) => {
          if (error) throw error;
          return ((data ?? []) as Array<{ name: string }>).map((a) => a.name);
        })
        .then(
          (v) => v,
          () => [] as string[],
        ),
    ]);

  const names = new Map(team.map((m) => [m.id, m.name]));
  const stored = new Map((map?.rows() ?? []).map((r: AccountMapRow) => [`${r.scope}|${r.key}`, r]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const row = (
    scope: MappingRowView['scope'],
    key: string,
    label: string,
    def: { code: string; name: string },
  ): MappingRowView => {
    const r = stored.get(`${scope}|${key}`);
    return {
      scope,
      key,
      label,
      accountCode: r?.account_code ?? def.code,
      accountName: r?.account_name ?? def.name,
      costCenter: r?.cost_center ?? null,
      refs: { ...(r?.provider_refs ?? {}) },
      custom: Boolean(r),
    };
  };
  const mapping: MappingRowView[] = [
    ...ACCOUNT_ROLE_KEYS.map((k) => row('rol', k, ACCOUNT_ROLE_LABEL[k], ACCOUNT_ROLE_DEFAULTS[k])),
    ...banks.map((b) => row('rol', bankRoleKey(b), `Banco: ${b}`, ACCOUNT_ROLE_DEFAULTS.banco)),
    ...LEDGER_CATEGORIES.filter((c) => ACCOUNT_CATEGORY_DEFAULTS[c]).map((c) =>
      row(
        'categoria',
        c,
        LEDGER_CATEGORY_LABEL[c] ?? c,
        ACCOUNT_CATEGORY_DEFAULTS[c] as { code: string; name: string },
      ),
    ),
    ...(map?.rows() ?? [])
      .filter((r) => r.scope === 'proveedor')
      .map((r) =>
        row('proveedor', r.key, `Proveedor: ${supplierName.get(r.key) ?? r.key}`, {
          code: r.account_code,
          name: r.account_name ?? '',
        }),
      ),
  ];

  const data: CloseScreenData = {
    today,
    period,
    periods: periods.includes(period) ? periods : [period, ...periods],
    view: viewRead.view,
    viewError: viewRead.error,
    queue: queueRead.queue,
    queueError: queueRead.error,
    history,
    mapping,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })),
    team,
    events: events.map((e) => ({
      kind: e.kind,
      who: e.userId ? (names.get(e.userId) ?? null) : null,
      detail: e.detail,
      at: e.at,
    })),
    canManage,
    links: {
      self: href('/cierre'),
      pdf: `/api/cierre/${period}/pdf`,
      integrations: href('/integrations#programas-contables'),
      approvals: href('/approvals'),
      chat: href('/chat'),
    },
    fixHref: Object.fromEntries(CLOSE_TASKS.map((t) => [t.key, href(t.fix.href)])),
  };

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <CloseScreen
        tab={tab}
        data={data}
        actions={{
          markTask: markTaskAction,
          assignTask: assignTaskAction,
          closePeriod: closePeriodAction,
          reopenPeriod: reopenPeriodAction,
          openOverride: openOverrideAction,
          preview: previewWritebackAction,
          register: registerWritebacksAction,
          discard: discardWritebackAction,
          restore: restoreWritebackAction,
          saveMapping: saveMappingAction,
          resetMapping: resetMappingAction,
        }}
      />
    </div>
  );
}
