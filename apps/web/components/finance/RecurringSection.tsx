'use client';

import {
  type Piece,
  type RecurringRow,
  cadenceText,
  formatMoney,
} from '@/lib/finance/dashboard-shape';
import type { StatusTone } from '@/lib/status-chip';
import { categoryLabel } from '@cortex/agent-tools/src/ledger/forecast-shared';
import { LEDGER_CATEGORIES } from '@cortex/agent-tools/src/ledger/types';
import { clsx } from 'clsx';
import { Check, Lock, Plus, Repeat, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ActionNote,
  NoData,
  Section,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from './pieces';
import type { FinanceActions } from './types';

/**
 * GASTOS FIJOS: lo que se repite (nómina el 30, arriendo el 5), detectado del
 * historial o dicho por una persona. Lo detectado espera un «Confirmar» o un
 * «No es fijo»; lo que se confirma o se agrega entra en la proyección.
 */
export function RecurringSection({
  recurring,
  isAdmin,
  currency,
  actions,
}: {
  recurring: Piece<RecurringRow[]>;
  isAdmin: boolean;
  currency: string;
  actions: FinanceActions;
}) {
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = recurring.ok ? recurring.data : [];
  const live = rows.filter((r) => r.status !== 'ignored');
  const ignored = rows.filter((r) => r.status === 'ignored');
  const pending = live.filter((r) => r.status === 'pending').length;
  const monthlyOut = live
    .filter((r) => r.flow.direction === 'out')
    .reduce((s, r) => s + (r.flow.every === 'week' ? (r.flow.amount * 52) / 12 : r.flow.amount), 0);

  return (
    <Section
      id="gastos-fijos"
      title="Gastos fijos"
      icon={<Repeat className="h-4 w-4" aria-hidden />}
      subtitle={
        recurring.ok && live.length > 0 ? (
          <>
            Unos{' '}
            <span className="tabular font-mono font-semibold text-ink">
              {formatMoney(monthlyOut, currency)}
            </span>{' '}
            al mes en lo que sale fijo
            {pending > 0 ? ` · ${pending} por confirmar` : ''}.
          </>
        ) : (
          'Lo que se repite cada semana o cada mes.'
        )
      }
      right={
        isAdmin && recurring.ok && !adding ? (
          <button type="button" className={pillLink} onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Agregar uno
          </button>
        ) : null
      }
    >
      {!recurring.ok ? (
        <NoData reason={recurring.error} />
      ) : (
        <div className="space-y-3">
          {adding && (
            <DeclareForm
              actions={actions}
              currency={currency}
              onDone={(text) => {
                setAdding(false);
                if (text) setNote({ ok: true, text });
              }}
            />
          )}
          {live.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Todavía no se ve nada que se repita. Con unos meses de extractos o del programa
              contable, Cortex encuentra la nómina, el arriendo y los servicios solo.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {live.map((r) => (
                <Row key={r.key} row={r} isAdmin={isAdmin} actions={actions} onNote={setNote} />
              ))}
            </ul>
          )}
          {ignored.length > 0 && (
            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer select-none font-semibold hover:text-ink">
                No son fijos ({ignored.length})
              </summary>
              <ul className="mt-2 divide-y divide-border/70">
                {ignored.map((r) => (
                  <Row key={r.key} row={r} isAdmin={isAdmin} actions={actions} onNote={setNote} />
                ))}
              </ul>
            </details>
          )}
          <ActionNote note={note} />
        </div>
      )}
    </Section>
  );
}

const STATUS_CHIP: Record<RecurringRow['status'], { tone: StatusTone; label: string }> = {
  pending: { tone: 'amber', label: 'Por confirmar' },
  confirmed: { tone: 'emerald', label: 'Confirmado' },
  declared: { tone: 'primary', label: 'Lo agregaste' },
  ignored: { tone: 'neutral', label: 'No es fijo' },
};

function Row({
  row,
  isAdmin,
  actions,
  onNote,
}: {
  row: RecurringRow;
  isAdmin: boolean;
  actions: FinanceActions;
  onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { flow } = row;
  const chip = STATUS_CHIP[row.status];
  const decide = (status: 'confirmed' | 'ignored') =>
    start(async () => {
      if (!row.detectedKey) return;
      const r = await actions.decideRecurring({ detectedKey: row.detectedKey, status });
      onNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <li
      className={clsx(
        'flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        pending && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {row.confidential && <Lock className="h-3.5 w-3.5 text-ink-faint" aria-hidden />}
          <span className="truncate">{flow.label}</span>
        </p>
        <p className="mt-0.5 text-micro text-ink-faint">
          {flow.direction === 'in' ? 'Entra' : 'Sale'} {cadenceText(flow)}
          {flow.category && !row.confidential ? ` · ${categoryLabel(flow.category)}` : ''}
          {row.status === 'pending' && flow.sample ? ` · visto ${flow.sample} veces` : ''}
          {row.confidential ? ' · total aproximado al mes; el detalle lo ve quien administra' : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
        <span
          className={clsx(
            'tabular whitespace-nowrap font-mono text-sm font-semibold',
            flow.direction === 'in' ? 'text-emerald' : 'text-ink',
          )}
        >
          {formatMoney(flow.amount, flow.currency)}
        </span>
        {!row.confidential && <span className={statusPill(chip.tone)}>{chip.label}</span>}
        {isAdmin && row.detectedKey && row.status === 'pending' && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => decide('confirmed')}
              className="inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-pill bg-emerald-soft px-3 text-xs font-semibold text-emerald hover:brightness-95"
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              Confirmar
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => decide('ignored')}
              className="inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-pill px-3 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              No es fijo
            </button>
          </>
        )}
        {isAdmin && row.detectedKey && row.status === 'ignored' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => decide('confirmed')}
            className="text-xs font-semibold text-primary hover:underline"
          >
            Sí es fijo
          </button>
        )}
      </div>
    </li>
  );
}

function DeclareForm({
  actions,
  currency,
  onDone,
}: {
  actions: FinanceActions;
  currency: string;
  onDone: (note: string | null) => void;
}) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [every, setEvery] = useState<'week' | 'month'>('month');
  const [anchor, setAnchor] = useState('5');
  const [category, setCategory] = useState('arriendo');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-2 rounded-sm bg-surface-2 p-3 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await actions.declareRecurring({
            label,
            direction,
            amount,
            every,
            anchor: Number(anchor),
            category,
            currency,
          });
          if (r.ok) {
            router.refresh();
            onDone(r.note);
          } else setError(r.error);
        });
      }}
    >
      <label className="block">
        <span className="field-label text-ink-faint">Qué es</span>
        <input
          className={`${fieldClass} mt-1`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Arriendo bodega"
          required
          maxLength={120}
        />
      </label>
      <label className="block">
        <span className="field-label text-ink-faint">Monto</span>
        <input
          className={`${fieldClass} tabular mt-1 font-mono`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="6.500.000"
          inputMode="decimal"
          required
        />
      </label>
      <label className="block">
        <span className="field-label text-ink-faint">Sentido</span>
        <select
          className={`${fieldClass} mt-1`}
          value={direction}
          onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
        >
          <option value="out">Sale (gasto)</option>
          <option value="in">Entra (ingreso)</option>
        </select>
      </label>
      <label className="block">
        <span className="field-label text-ink-faint">Cada cuánto</span>
        <select
          className={`${fieldClass} mt-1`}
          value={every}
          onChange={(e) => {
            const v = e.target.value as 'week' | 'month';
            setEvery(v);
            setAnchor(v === 'week' ? '1' : '5');
          }}
        >
          <option value="month">Cada mes</option>
          <option value="week">Cada semana</option>
        </select>
      </label>
      {every === 'week' ? (
        <label className="block">
          <span className="field-label text-ink-faint">Qué día</span>
          <select
            className={`${fieldClass} mt-1`}
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          >
            {['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'].map(
              (d, i) => (
                <option key={d} value={String(i + 1)}>
                  {d}
                </option>
              ),
            )}
          </select>
        </label>
      ) : (
        <label className="block">
          <span className="field-label text-ink-faint">Día del mes</span>
          <input
            type="number"
            min={1}
            max={31}
            className={`${fieldClass} tabular mt-1 font-mono`}
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
        </label>
      )}
      <label className="block">
        <span className="field-label text-ink-faint">Categoría</span>
        <select
          className={`${fieldClass} mt-1`}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {LEDGER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
        <button type="submit" className={pillPrimary} disabled={pending}>
          {pending ? 'Agregando…' : 'Agregar a los fijos'}
        </button>
        <button type="button" className={pillLink} onClick={() => onDone(null)}>
          Cancelar
        </button>
        {error && (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
