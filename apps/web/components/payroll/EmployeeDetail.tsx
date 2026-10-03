'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { Calculator } from 'lucide-react';
import { useState, useTransition } from 'react';
import { EmployeeForm, type SaveEmployee } from './EmployeeForm';
import { PayslipCard, money } from './PayslipCard';
import type {
  ActionResult,
  EmployeeView,
  LeaveView,
  Option,
  PayLineView,
  PayslipView,
} from './types';

/**
 * LA FICHA DE UNA PERSONA EN LA NÓMINA (sólo quien administra): sus datos,
 * su historia de desprendibles, su saldo de vacaciones y ausencias, el retiro
 * y la liquidación del contrato ESTIMADA.
 */

type Estimate = ActionResult & { lines?: PayLineView[]; total?: number; notes?: string[] };

export function EmployeeDetail({
  employee,
  payslips,
  leave,
  balance,
  contractTypes,
  terminationReasons,
  team,
  today,
  actions,
}: {
  employee: EmployeeView;
  payslips: PayslipView[];
  leave: LeaveView[];
  balance: { days: number; explanation: string } | null;
  contractTypes: Option[];
  terminationReasons: Option[];
  team: Option[];
  today: string;
  actions: {
    save: SaveEmployee;
    retire: (input: {
      id: string;
      endDate: string;
      reason: string | null;
    }) => Promise<ActionResult>;
    estimate: (input: {
      employeeId: string;
      terminationDate: string;
      reason: string;
    }) => Promise<Estimate>;
  };
}) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [end, setEnd] = useState(today);
  const [reason, setReason] = useState('sin_justa_causa');
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Contrato', employee.contractLabel],
          ['Salario', `${money(employee.salary)}${employee.integral ? ' (integral)' : ''}`],
          ['Ingreso', employee.startDate],
          ['Vacaciones', balance ? `${balance.days} días hábiles` : '—'],
        ].map(([k, v]) => (
          <Panel key={k} className="px-4 py-3">
            <div className="text-xs text-ink-muted">{k}</div>
            <div className="text-base font-bold text-ink">{v}</div>
          </Panel>
        ))}
      </div>
      {balance && <p className="text-xs text-ink-muted">{balance.explanation}</p>}

      <Panel className="p-5">
        <h2 className="mb-4 text-base font-bold text-ink">Datos</h2>
        <EmployeeForm
          initial={employee}
          contractTypes={contractTypes}
          team={team}
          save={actions.save}
        />
      </Panel>

      <section className="space-y-3">
        <h2 className="text-base font-bold text-ink">Historia de pagos</h2>
        {payslips.length === 0 ? (
          <Panel className="p-5 text-sm text-ink-muted">Todavía no tiene nóminas liquidadas.</Panel>
        ) : (
          payslips.map((s, i) => <PayslipCard key={s.periodId} slip={s} open={i === 0} full />)
        )}
      </section>

      <Panel className="p-5">
        <h2 className="mb-3 text-base font-bold text-ink">Vacaciones y ausencias</h2>
        {leave.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin solicitudes.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {leave.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {l.kindLabel} · {l.start} a {l.end} ({l.businessDays} hábiles)
                </span>
                <span
                  className={statusPill(
                    l.status === 'aprobada'
                      ? 'emerald'
                      : l.status === 'pendiente'
                        ? 'amber'
                        : 'neutral',
                  )}
                >
                  {l.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {employee.status === 'activo' && (
        <Panel className="space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-ink">
            <Calculator className="h-4 w-4 text-ink-faint" aria-hidden />
            Retiro y liquidación del contrato (estimada)
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs font-semibold text-ink-muted">
              Fecha de terminación
              <input
                type="date"
                className={fieldClass}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Motivo
              <select
                className={fieldClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                {terminationReasons.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                className={pillLink}
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await actions.estimate({
                      employeeId: employee.id,
                      terminationDate: end,
                      reason,
                    });
                    setEstimate(r);
                    setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
                  })
                }
              >
                Estimar
              </button>
              <button
                type="button"
                className={pillPrimary}
                disabled={pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      `¿Registrar el retiro de ${employee.name} el ${end}? No borra su historia.`,
                    )
                  )
                    return;
                  start(async () => {
                    const r = await actions.retire({ id: employee.id, endDate: end, reason });
                    setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
                  });
                }}
              >
                Registrar retiro
              </button>
            </div>
          </div>
          <ActionNote note={note} />
          {estimate?.ok && estimate.lines && (
            <div className="space-y-2">
              <ul className="divide-y divide-border">
                {estimate.lines.map((l) => (
                  <li key={l.code} className="py-1.5">
                    <div className="flex justify-between text-sm">
                      <span>{l.label}</span>
                      <span className="tabular-nums font-semibold">{money(l.amount)}</span>
                    </div>
                    <p className="text-xs text-ink-muted">{l.explanation}</p>
                  </li>
                ))}
              </ul>
              <p className="text-sm font-bold text-ink">
                Total estimado: {money(estimate.total ?? 0)}
              </p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-amber">
                {(estimate.notes ?? []).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
