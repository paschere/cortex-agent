'use client';

import { statusPill } from '@/components/finance/pieces';
import { clsx } from 'clsx';
import { ChevronDown, Info } from 'lucide-react';
import { useState } from 'react';
import type { PayLineView, PayslipView } from './types';

/**
 * EL DESPRENDIBLE: lo devengado, lo deducido y el neto, y cada línea con su
 * cuenta escrita («30 días × $58.364»). A quien administra le muestra además
 * los aportes de la empresa y las provisiones (costo de la empresa, no de la
 * persona).
 */

export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CO')}`;
}

const GROUP_LABEL: Record<PayLineView['group'], string> = {
  devengado: 'Devengado',
  deduccion: 'Deducciones',
  aporte_empleador: 'Aportes de la empresa',
  provision: 'Provisiones (prestaciones)',
};

function Lines({ lines, group }: { lines: PayLineView[]; group: PayLineView['group'] }) {
  const list = lines.filter((l) => l.group === group);
  if (!list.length) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-faint">
        {GROUP_LABEL[group]}
      </h4>
      <ul className="divide-y divide-border">
        {list.map((l, i) => (
          <li key={`${l.code}-${i}`} className="py-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink">
                {l.label}
                {l.estimate && (
                  <span className="ml-1.5 text-micro font-semibold text-amber">estimado</span>
                )}
              </span>
              <span className="tabular-nums font-semibold text-ink">{money(l.amount)}</span>
            </div>
            <p className="text-xs text-ink-muted">{l.explanation}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PayslipCard({
  slip,
  open: initial = false,
  full = false,
}: { slip: PayslipView; open?: boolean; full?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <div className="text-sm font-bold text-ink">
            {slip.periodLabel}
            {full ? ` · ${slip.employeeName}` : ''}
          </div>
          <div className="text-xs text-ink-muted">
            Pago el {slip.payDate} · {slip.days.contract} días · IBC {money(slip.ibc)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={statusPill(
              slip.status === 'pagado'
                ? 'emerald'
                : slip.status === 'aprobado'
                  ? 'primary'
                  : 'amber',
            )}
          >
            {slip.statusLabel}
          </span>
          <span className="text-right">
            <span className="block text-micro text-ink-faint">Neto</span>
            <span className="tabular-nums text-base font-extrabold text-ink">
              {money(slip.neto)}
            </span>
          </span>
          <ChevronDown
            className={clsx('h-4 w-4 text-ink-faint transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </div>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-ink-muted">Devengado</dt>
              <dd className="tabular-nums font-bold">{money(slip.devengado)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Deducciones</dt>
              <dd className="tabular-nums font-bold">{money(slip.deducciones)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Neto a pagar</dt>
              <dd className="tabular-nums font-extrabold text-primary">{money(slip.neto)}</dd>
            </div>
          </dl>
          <Lines lines={slip.lines} group="devengado" />
          <Lines lines={slip.lines} group="deduccion" />
          {full && (
            <>
              <Lines lines={slip.lines} group="aporte_empleador" />
              <Lines lines={slip.lines} group="provision" />
              <p className="text-sm text-ink">
                Costo total para la empresa:{' '}
                <strong className="tabular-nums">{money(slip.costoTotal)}</strong>
              </p>
            </>
          )}
          {(slip.warnings.length > 0 || slip.estimates.length > 0) && (
            <ul className="space-y-1 rounded-sm bg-surface-2 p-3 text-xs text-ink-muted">
              {[...slip.warnings, ...slip.estimates].map((w) => (
                <li key={w} className="flex gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          )}
          <p className="text-micro text-ink-faint">Parámetros legales: {slip.paramsVersion}</p>
        </div>
      )}
    </div>
  );
}
