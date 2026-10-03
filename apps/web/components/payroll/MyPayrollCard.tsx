import { pillLink } from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { companyModules } from '@/lib/modules/server';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  getPayrollEmployee,
  listLeaveRequests,
  listPayslips,
  payrollAccess,
  vacationBalanceFor,
} from '@cortex/agent-tools';
import { CalendarPlus, Wallet } from 'lucide-react';
import Link from 'next/link';

/**
 * «MI NÓMINA» EN MI SEMANA (0194): el último desprendible aprobado y el saldo
 * de vacaciones de quien mira, y nada de nadie más. Sólo si el módulo de
 * nómina está prendido y la persona está vinculada a la nómina. Si algo
 * falla, no se pinta (Mi semana no se cae por la nómina).
 */
export async function MyPayrollCard({
  organizationId,
  userId,
}: { organizationId: string; userId: string }) {
  try {
    const modules = await companyModules(organizationId);
    if (!modules.has('payroll')) return null;
    const db = getOrgScopedClient(organizationId);
    const access = await payrollAccess(db, userId);
    if (!access.employeeId) return null;
    const me = await getPayrollEmployee(db, access.employeeId);
    if (!me || me.contractType === 'prestacion_servicios') return null;
    const today = bogotaToday();
    const [slips, balance, pending] = await Promise.all([
      listPayslips(db, { employeeId: me.id, viewerId: userId, limit: 3 }),
      vacationBalanceFor(db, me, today),
      listLeaveRequests(db, { employeeId: me.id, statuses: ['pendiente'], limit: 5 }),
    ]);
    const last = slips[0];
    const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    return (
      <Panel className="mt-6 grid gap-4 p-5 sm:grid-cols-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Wallet className="h-4 w-4 text-ink-faint" aria-hidden />
            Mi último pago
          </div>
          {last ? (
            <p className="mt-1 text-sm text-ink">
              {last.period.label}: neto{' '}
              <strong className="tabular-nums">{money(last.liquidation.totals.neto)}</strong> (pago
              el {last.period.payDate}).
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">Todavía no hay desprendibles aprobados.</p>
          )}
          <Link href="/nomina" className={`${pillLink} mt-2`}>
            Ver mis desprendibles
          </Link>
        </div>
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <CalendarPlus className="h-4 w-4 text-ink-faint" aria-hidden />
            Mis vacaciones
          </div>
          <p className="mt-1 text-sm text-ink">
            <strong className="tabular-nums">{balance.balance}</strong> días hábiles disponibles
            {pending.length
              ? ` · ${pending.length} ${pending.length === 1 ? 'solicitud pendiente' : 'solicitudes pendientes'}`
              : ''}
            .
          </p>
          <Link href="/nomina" className={`${pillLink} mt-2`}>
            Pedir vacaciones o un permiso
          </Link>
        </div>
      </Panel>
    );
  } catch {
    return null;
  }
}
