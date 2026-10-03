import { EmployeeDetail } from '@/components/payroll/EmployeeDetail';
import { PageHeader } from '@/components/ui/page-header';
import { loadTeam } from '@/lib/clients/read';
import { employeeView, leaveView, payrollOptions, payslipView } from '@/lib/payroll/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  getPayrollEmployee,
  listLeaveRequests,
  listPayslips,
  payrollAccess,
  vacationBalanceFor,
} from '@cortex/agent-tools';
import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { retireEmployeeAction, saveEmployeeAction, terminationEstimateAction } from '../../actions';

/**
 * La ficha de una persona en la nómina (0194). Sólo quien administra: los
 * demás no ven salarios ajenos (y su propia nómina está en /nomina).
 */

export const dynamic = 'force-dynamic';

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const access = await payrollAccess(db, user.id);
  if (!access.manager) notFound();
  const employee = await getPayrollEmployee(db, id);
  if (!employee) notFound();
  const today = bogotaToday();
  const [slips, balance, leave, team] = await Promise.all([
    listPayslips(db, { employeeId: id, viewerId: user.id, limit: 24 }),
    employee.contractType === 'prestacion_servicios'
      ? Promise.resolve(null)
      : vacationBalanceFor(db, employee, today),
    listLeaveRequests(db, { employeeId: id, limit: 50 }),
    loadTeam(db).catch(() => []),
  ]);
  const names = new Map([[employee.id, employee.name]]);
  const options = payrollOptions(team);
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={employee.name}
        subtitle={`${employee.jobTitle ?? 'Sin cargo'} · ${employee.documentType} ${employee.documentNumber}${employee.status === 'retirado' ? ' · retirado' : ''}. Confidencial: sólo quien administra ve esta ficha.`}
        icon={<UserRound className="h-5 w-5" aria-hidden />}
        actions={
          <Link href="/nomina?tab=personas" className="text-sm font-semibold text-primary">
            ← Todas las personas
          </Link>
        }
      />
      <EmployeeDetail
        employee={employeeView(employee, balance?.balance ?? null)}
        payslips={slips.map((s) => payslipView(s.period, s.liquidation))}
        leave={leave.map((r) => leaveView(r, names, { canDecide: false, mine: false }))}
        balance={balance ? { days: balance.balance, explanation: balance.explanation } : null}
        contractTypes={options.contractTypes}
        terminationReasons={options.terminationReasons}
        team={options.team}
        today={today}
        actions={{
          save: saveEmployeeAction,
          retire: retireEmployeeAction,
          estimate: terminationEstimateAction,
        }}
      />
    </div>
  );
}
