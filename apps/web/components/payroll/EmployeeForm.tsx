'use client';

import { ActionNote, fieldClass, pillPrimary } from '@/components/finance/pieces';
import { useState, useTransition } from 'react';
import type { ActionResult, EmployeeView, Option } from './types';

/**
 * La ficha de una persona en la nómina: documento, contrato, salario,
 * seguridad social y cuenta. De la cuenta bancaria Cortex guarda SÓLO los
 * últimos cuatro dígitos (el resto ni se envía al servidor).
 */

export type SaveEmployee = (
  input: Record<string, unknown>,
) => Promise<ActionResult & { id?: string }>;

const DOCS = ['CC', 'CE', 'PA', 'TI', 'PEP', 'PPT'];

export function EmployeeForm({
  initial,
  contractTypes,
  team,
  save,
  onSaved,
}: {
  initial?: EmployeeView | null;
  contractTypes: Option[];
  team: Option[];
  save: SaveEmployee;
  onSaved?: (id: string | undefined) => void;
}) {
  const [f, setF] = useState(() => ({
    name: initial?.name ?? '',
    documentType: initial?.documentType ?? 'CC',
    documentNumber: initial?.documentNumber ?? '',
    email: initial?.email ?? '',
    jobTitle: initial?.jobTitle ?? '',
    contractType: initial?.contractType ?? 'indefinido',
    startDate: initial?.startDate ?? '',
    endDate: initial?.endDate ?? '',
    salary: initial ? String(initial.salary) : '',
    integral: initial?.integral ?? false,
    apprenticePhase: initial?.apprenticePhase ?? 'lectiva',
    arlClass: String(initial?.arlClass ?? 1),
    eps: initial?.eps ?? '',
    afp: initial?.afp ?? '',
    ccf: initial?.ccf ?? '',
    arl: initial?.arl ?? '',
    cesantiasFund: initial?.cesantiasFund ?? '',
    bankName: initial?.bankName ?? '',
    bankAccountType: initial?.bankAccountType ?? '',
    bankAccount: '',
    costCenter: initial?.costCenter ?? '',
    dependents: initial?.dependents ?? false,
    vacationOpeningDays: String(initial?.vacationOpeningDays ?? 0),
    vacationOpeningAsOf: initial?.vacationOpeningAsOf ?? '',
    userId: initial?.userId ?? '',
  }));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string | boolean) => setF((prev) => ({ ...prev, [k]: v }));

  const text = (
    k: keyof typeof f,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label className="block text-xs font-semibold text-ink-muted">
      {label}
      <input
        className={fieldClass}
        value={String(f[k])}
        onChange={(e) => set(k, e.target.value)}
        {...props}
      />
    </label>
  );

  const submit = () =>
    start(async () => {
      // Sólo los últimos 4 dígitos viajan al servidor.
      const digits = f.bankAccount.replace(/\D/g, '');
      const r = await save({
        id: initial?.id ?? null,
        name: f.name.trim(),
        documentType: f.documentType,
        documentNumber: f.documentNumber.trim(),
        email: f.email.trim() || null,
        jobTitle: f.jobTitle.trim() || null,
        contractType: f.contractType,
        startDate: f.startDate,
        endDate: f.endDate || null,
        salary: Number(f.salary.replace(/[^\d.]/g, '')) || 0,
        integral: f.integral,
        apprenticePhase: f.contractType === 'aprendizaje' ? f.apprenticePhase : null,
        arlClass: Number(f.arlClass) || 1,
        eps: f.eps || null,
        afp: f.afp || null,
        ccf: f.ccf || null,
        arl: f.arl || null,
        cesantiasFund: f.cesantiasFund || null,
        bankName: f.bankName || null,
        bankAccountType: f.bankAccountType || null,
        ...(digits.length >= 4 ? { bankAccount: digits.slice(-4) } : {}),
        costCenter: f.costCenter || null,
        dependents: f.dependents,
        vacationOpeningDays: Number(f.vacationOpeningDays) || 0,
        vacationOpeningAsOf: f.vacationOpeningAsOf || null,
        userId: f.userId || null,
      });
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) onSaved?.(r.id);
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {text('name', 'Nombre completo', { required: true, maxLength: 160 })}
        <label className="block text-xs font-semibold text-ink-muted">
          Tipo de documento
          <select
            className={fieldClass}
            value={f.documentType}
            onChange={(e) => set('documentType', e.target.value)}
          >
            {DOCS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        {text('documentNumber', 'Número de documento', { required: true, maxLength: 20 })}
        {text('email', 'Correo', { type: 'email' })}
        {text('jobTitle', 'Cargo')}
        <label className="block text-xs font-semibold text-ink-muted">
          Cuenta de Cortex (para que vea lo suyo)
          <select
            className={fieldClass}
            value={f.userId}
            onChange={(e) => set('userId', e.target.value)}
          >
            <option value="">Sin vincular</option>
            {team.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs font-semibold text-ink-muted">
          Contrato
          <select
            className={fieldClass}
            value={f.contractType}
            onChange={(e) => set('contractType', e.target.value)}
          >
            {contractTypes.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {text('startDate', 'Ingreso', { type: 'date', required: true })}
        {text('endDate', f.contractType === 'fijo' ? 'Terminación pactada' : 'Retiro (si aplica)', {
          type: 'date',
        })}
        {text(
          'salary',
          f.contractType === 'aprendizaje' ? 'Apoyo de sostenimiento mensual' : 'Salario mensual',
          {
            inputMode: 'numeric',
            required: true,
          },
        )}
        {f.contractType === 'aprendizaje' ? (
          <label className="block text-xs font-semibold text-ink-muted">
            Etapa
            <select
              className={fieldClass}
              value={f.apprenticePhase}
              onChange={(e) => set('apprenticePhase', e.target.value)}
            >
              <option value="lectiva">Lectiva</option>
              <option value="productiva">Productiva</option>
            </select>
          </label>
        ) : (
          <label className="flex items-center gap-2 pt-5 text-sm text-ink">
            <input
              type="checkbox"
              checked={f.integral}
              onChange={(e) => set('integral', e.target.checked)}
            />
            Salario integral
          </label>
        )}
        <label className="block text-xs font-semibold text-ink-muted">
          Clase de riesgo ARL
          <select
            className={fieldClass}
            value={f.arlClass}
            onChange={(e) => set('arlClass', e.target.value)}
          >
            {[1, 2, 3, 4, 5].map((c) => (
              <option key={c} value={c}>
                {['I', 'II', 'III', 'IV', 'V'][c - 1]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm text-ink">
          <input
            type="checkbox"
            checked={f.dependents}
            onChange={(e) => set('dependents', e.target.checked)}
          />
          Tiene dependientes (retención)
        </label>
        {text('costCenter', 'Centro de costo')}
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        {text('eps', 'EPS')}
        {text('afp', 'Fondo de pensiones')}
        {text('cesantiasFund', 'Fondo de cesantías')}
        {text('ccf', 'Caja de compensación')}
        {text('arl', 'ARL')}
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        {text('bankName', 'Banco')}
        <label className="block text-xs font-semibold text-ink-muted">
          Tipo de cuenta
          <select
            className={fieldClass}
            value={f.bankAccountType}
            onChange={(e) => set('bankAccountType', e.target.value)}
          >
            <option value="">—</option>
            <option value="ahorros">Ahorros</option>
            <option value="corriente">Corriente</option>
            <option value="deposito">Depósito electrónico</option>
          </select>
        </label>
        {text(
          'bankAccount',
          initial?.bankAccountLast4
            ? `Cuenta (hoy ****${initial.bankAccountLast4})`
            : 'Cuenta (sólo se guardan los 4 últimos)',
          {
            inputMode: 'numeric',
            autoComplete: 'off',
          },
        )}
        {text('vacationOpeningDays', 'Saldo de vacaciones que traía', { inputMode: 'decimal' })}
        {text('vacationOpeningAsOf', 'A la fecha', { type: 'date' })}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className={pillPrimary} disabled={pending} onClick={submit}>
          {initial ? 'Guardar cambios' : 'Agregar a la nómina'}
        </button>
        <ActionNote note={note} />
      </div>
    </div>
  );
}
