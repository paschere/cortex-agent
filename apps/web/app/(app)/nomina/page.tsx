import { PayrollConsole } from '@/components/payroll/PayrollConsole';
import { PayrollSelf } from '@/components/payroll/PayrollSelf';
import type { LeaveView, PayslipView } from '@/components/payroll/types';
import { PageHeader } from '@/components/ui/page-header';
import { loadTeam } from '@/lib/clients/read';
import {
  employeeView,
  leaveView,
  noveltyView,
  ownPayslipView,
  payrollOptions,
  payslipView,
  periodView,
} from '@/lib/payroll/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  NE_GUIDE,
  PAYMENT_GUIDE,
  PILA_GUIDE,
  bogotaToday,
  currentPayrollPeriod,
  getPayrollEmployee,
  listLeaveRequests,
  listPayrollEmployees,
  listPayrollNovelties,
  listPayrollPeriods,
  listPayslips,
  loadPeriodLiquidations,
  payrollAccess,
  payrollParamsFor,
  readPayrollSettings,
  vacationBalanceFor,
} from '@cortex/agent-tools';
import { Wallet } from 'lucide-react';
import {
  addNoveltyAction,
  approvePeriodAction,
  cancelLeaveAction,
  decideLeaveAction,
  liquidatePeriodAction,
  markPaidAction,
  openPeriodAction,
  requestLeaveAction,
  saveEmployeeAction,
  savePayrollSettingsAction,
  voidNoveltyAction,
  voidPeriodAction,
} from './actions';

/**
 * /nomina (0194): la nómina colombiana liquidada en Cortex.
 *
 * Quien administra la empresa ve la consola entera: periodos con su
 * liquidación en la grilla, personas, novedades, vacaciones y permisos,
 * exportaciones (PILA, nómina electrónica, instrucciones de pago) y la
 * configuración. Cualquier otra persona ve SÓLO lo suyo: sus desprendibles,
 * su saldo de vacaciones y sus solicitudes (y las de quienes le reportan,
 * para aprobarlas, sin salarios). La regla vive en payroll/store.ts.
 */

export const dynamic = 'force-dynamic';

const TABS = ['periodos', 'personas', 'novedades', 'ausencias', 'configuracion'] as const;
type Tab = (typeof TABS)[number];

export default async function NominaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const access = await payrollAccess(db, user.id);
  const header = (
    <PageHeader
      title="Nómina"
      subtitle={
        access.manager
          ? 'La nómina con la ley colombiana: novedades, liquidación explicada línea por línea, aprobación, PILA y nómina electrónica. Cortex nunca paga: tú pagas desde el banco.'
          : 'Tus desprendibles de pago, tu saldo de vacaciones y tus solicitudes. Los salarios de los demás son confidenciales.'
      }
      icon={<Wallet className="h-5 w-5" aria-hidden />}
    />
  );

  // --- Quien no administra: sólo lo suyo ------------------------------------
  if (!access.manager) {
    const [me, reports] = await Promise.all([
      access.employeeId ? getPayrollEmployee(db, access.employeeId) : Promise.resolve(null),
      // Las personas que le reportan (para aprobar sus ausencias).
      db
        .from('users')
        .select('id')
        .eq('manager_id', user.id)
        .limit(200),
    ]);
    if (reports.error) throw reports.error;
    const reportUserIds = new Set(((reports.data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const all = reportUserIds.size ? await listPayrollEmployees(db) : [];
    const reportEmployees = all.filter((e) => e.userId && reportUserIds.has(e.userId));
    const names = new Map<string, string>([...reportEmployees.map((e) => [e.id, e.name] as const)]);
    if (me) names.set(me.id, me.name);
    const [slips, balance, mine, teamPending, settings] = await Promise.all([
      me
        ? listPayslips(db, { employeeId: me.id, viewerId: user.id, limit: 12 })
        : Promise.resolve([]),
      me ? vacationBalanceFor(db, me, today) : Promise.resolve(null),
      me ? listLeaveRequests(db, { employeeId: me.id, limit: 50 }) : Promise.resolve([]),
      reportEmployees.length
        ? listLeaveRequests(db, { statuses: ['pendiente'], limit: 100 }).then((l) =>
            l.filter((r) => reportEmployees.some((e) => e.id === r.employeeId)),
          )
        : Promise.resolve([]),
      readPayrollSettings(db),
    ]);
    const payslips: PayslipView[] = slips.map((s) => ownPayslipView(s.period, s.liquidation));
    const leave: LeaveView[] = [
      ...mine.map((r) => leaveView(r, names, { canDecide: false, mine: true })),
      ...teamPending.map((r) => leaveView(r, names, { canDecide: true, mine: false })),
    ];
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
        {header}
        <PayrollSelf
          linked={Boolean(me)}
          name={me?.name ?? user.name ?? user.email}
          payslips={payslips}
          balance={
            balance
              ? {
                  days: balance.balance,
                  explanation: balance.explanation,
                  pendingPeriods: balance.pendingPeriods,
                }
              : null
          }
          leave={leave}
          options={payrollOptions([])}
          saturdayIsWorkday={settings.saturdayIsWorkday}
          actions={{
            request: requestLeaveAction,
            cancel: cancelLeaveAction,
            decide: decideLeaveAction,
          }}
        />
      </div>
    );
  }

  // --- Quien administra: la consola -----------------------------------------
  const tab: Tab = TABS.includes(q.tab as Tab) ? (q.tab as Tab) : 'periodos';
  const [settings, employees, periods, team] = await Promise.all([
    readPayrollSettings(db),
    listPayrollEmployees(db, { includeRetired: true }),
    listPayrollPeriods(db, { limit: 36 }),
    loadTeam(db).catch(() => []),
  ]);
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const selectedId = typeof q.periodo === 'string' ? q.periodo : (periods[0]?.id ?? null);
  const selected = periods.find((p) => p.id === selectedId) ?? null;
  const fromDay = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`;

  const [liq, novelties, leaveRows, balances] = await Promise.all([
    selected && selected.status !== 'borrador'
      ? loadPeriodLiquidations(db, [selected.id], { userId: user.id })
      : Promise.resolve(null),
    tab === 'novedades' || tab === 'periodos'
      ? listPayrollNovelties(db, { from: fromDay })
      : Promise.resolve([]),
    tab === 'ausencias' || tab === 'periodos'
      ? listLeaveRequests(db, { limit: 300 })
      : Promise.resolve([]),
    tab === 'personas' || tab === 'ausencias'
      ? Promise.all(
          employees
            .filter((e) => e.status === 'activo' && e.contractType !== 'prestacion_servicios')
            .slice(0, 300)
            .map(
              async (e) =>
                [
                  e.id,
                  (await vacationBalanceFor(db, e, today).catch(() => null))?.balance ?? null,
                ] as const,
            ),
        ).then((list) => new Map(list))
      : Promise.resolve(new Map<string, number | null>()),
  ]);

  // La sugerencia de próximo periodo: el actual si no existe; si no, el siguiente al último.
  const current = currentPayrollPeriod(today, settings.frequency);
  const hasCurrent = periods.some((p) => p.start === current.start && p.end === current.end);
  const params = (() => {
    try {
      const p = payrollParamsFor(today);
      return { version: p.version, sources: p.sources, needsConfirmation: p.needsConfirmation };
    } catch {
      return { version: '—', sources: 'Sin parámetros cargados para hoy.', needsConfirmation: [] };
    }
  })();

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      {header}
      <PayrollConsole
        tab={tab}
        today={today}
        settings={settings}
        employees={employees.map((e) => employeeView(e, balances.get(e.id) ?? null))}
        periods={periods.map(periodView)}
        selected={selected ? periodView(selected) : null}
        payslips={selected && liq ? liq.liquidations.map((l) => payslipView(selected, l)) : []}
        novelties={novelties.map((n) => noveltyView(n, names))}
        leave={leaveRows.map((r) =>
          leaveView(r, names, { canDecide: true, mine: r.employeeId === access.employeeId }),
        )}
        suggestion={hasCurrent ? null : current}
        options={payrollOptions(team)}
        guides={{ pila: PILA_GUIDE, electronica: NE_GUIDE, pagos: PAYMENT_GUIDE, params }}
        exportBase="/api/nomina/export"
        actions={{
          saveSettings: savePayrollSettingsAction,
          saveEmployee: saveEmployeeAction,
          openPeriod: openPeriodAction,
          liquidate: liquidatePeriodAction,
          approve: approvePeriodAction,
          markPaid: markPaidAction,
          voidPeriod: voidPeriodAction,
          addNovelty: addNoveltyAction,
          voidNovelty: voidNoveltyAction,
          requestLeave: requestLeaveAction,
          decideLeave: decideLeaveAction,
          cancelLeave: cancelLeaveAction,
        }}
      />
    </div>
  );
}
