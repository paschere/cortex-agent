'use client';

import { Panel } from '@/components/ui/panel';
import { type LeaveActions, LeavePanel } from './LeavePanel';
import { PayslipCard } from './PayslipCard';
import type { LeaveView, PayrollOptions, PayslipView } from './types';

/**
 * /nomina PARA QUIEN NO ADMINISTRA: lo suyo y nada más. Sus desprendibles
 * aprobados, su saldo de vacaciones, sus solicitudes, y las pendientes de
 * quienes le reportan (sin salarios) para aprobarlas.
 */
export function PayrollSelf({
  linked,
  name,
  payslips,
  balance,
  leave,
  options,
  actions,
}: {
  linked: boolean;
  name: string;
  payslips: PayslipView[];
  balance: { days: number; explanation: string; pendingPeriods: number } | null;
  leave: LeaveView[];
  options: PayrollOptions;
  saturdayIsWorkday: boolean;
  actions: LeaveActions;
}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!linked)
    return (
      <Panel className="p-6">
        <p className="text-sm text-ink">
          {name}, tu cuenta de Cortex todavía no está vinculada a la nómina de la empresa. Pídele a
          quien la administra que te registre (o que vincule tu cuenta en tu ficha) para ver tus
          desprendibles y pedir vacaciones desde aquí.
        </p>
      </Panel>
    );
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-bold text-ink">Mis desprendibles</h2>
        {payslips.length === 0 ? (
          <Panel className="p-5 text-sm text-ink-muted">
            Todavía no hay desprendibles aprobados.
          </Panel>
        ) : (
          payslips.map((s, i) => <PayslipCard key={s.periodId} slip={s} open={i === 0} />)
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-bold text-ink">Vacaciones y permisos</h2>
        <LeavePanel
          leave={leave}
          kinds={options.leaveKinds}
          today={today}
          actions={actions}
          balance={balance}
        />
      </section>
    </div>
  );
}
