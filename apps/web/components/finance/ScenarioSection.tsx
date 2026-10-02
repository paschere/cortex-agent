'use client';

import {
  DRAFT_KIND_LABEL,
  type DraftKind,
  type DraftRow,
  type Piece,
  type ScenarioChip,
  chatHref,
  dashboardHref,
  draftToAdjustment,
  emptyDraft,
} from '@/lib/finance/dashboard-shape';
import { categoryLabel } from '@cortex/agent-tools/src/ledger/forecast-shared';
import { describeScenario } from '@cortex/agent-tools/src/ledger/scenario';
import { LEDGER_CATEGORIES, type ScenarioAdjustment } from '@cortex/agent-tools/src/ledger/types';
import { clsx } from 'clsx';
import { GitBranch, Plus, Sparkles, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { ActionNote, NoData, Section, fieldClass, pillLink, pillPrimary } from './pieces';
import type { FinanceActions } from './types';

/**
 * ESCENARIOS: «¿y si Nexa paga 30 días tarde?». Los guardados son chips (tocar
 * uno lo pinta encima de la proyección); «Nuevo escenario» arma uno con filas
 * de cambios y lo dice en una frase mientras se escribe. Guardar lo abre.
 * Un escenario no toca el libro: es una pregunta, no un movimiento.
 */
export function ScenarioSection({
  scenarios,
  activeId,
  self,
  chat,
  params,
  today,
  currency,
  counterparties,
  actions,
}: {
  scenarios: Piece<ScenarioChip[]>;
  activeId: string | null;
  self: string;
  chat: string;
  params: { includeEstimatedSales: boolean; minimumCash: number | null };
  today: string;
  currency: string;
  counterparties: string[];
  actions: FinanceActions;
}) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const active = scenarios.ok ? scenarios.data.find((s) => s.id === activeId) : undefined;

  return (
    <Section
      id="escenarios"
      title="Escenarios"
      icon={<GitBranch className="h-4 w-4" aria-hidden />}
      subtitle="Prueba un «¿y si…?» sin tocar el libro: la línea punteada del flujo muestra cómo cambia la caja."
      right={
        <Link
          href={chatHref(
            chat,
            'Arma un escenario para mi caja de las próximas 13 semanas: ¿qué pasa si mi cliente más grande me paga 30 días tarde y además sube la nómina 10 %?',
          )}
          className={pillLink}
        >
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
          Pídeselo a Cortex
        </Link>
      }
    >
      {!scenarios.ok ? (
        <NoData reason={scenarios.error} />
      ) : (
        <div className="space-y-4">
          <ul className="flex flex-wrap gap-2" aria-label="Escenarios guardados">
            <li>
              <Link
                href={dashboardHref(self, { ...params, scenarioId: null }, 'flujo')}
                scroll={false}
                aria-current={!activeId ? 'true' : undefined}
                className={chip(!activeId)}
              >
                Base
              </Link>
            </li>
            {scenarios.data.map((s) => (
              <li key={s.id}>
                <Link
                  href={dashboardHref(self, { ...params, scenarioId: s.id }, 'flujo')}
                  scroll={false}
                  title={s.description}
                  aria-current={s.id === activeId ? 'true' : undefined}
                  className={chip(s.id === activeId)}
                >
                  {s.label}
                </Link>
              </li>
            ))}
            {!building && (
              <li>
                <button
                  type="button"
                  onClick={() => setBuilding(true)}
                  className={clsx(chip(false), 'border-dashed')}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Nuevo escenario
                </button>
              </li>
            )}
          </ul>

          {active && (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-sm bg-surface-2 px-4 py-3">
              <p className="min-w-0 text-sm text-ink">{active.description}</p>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await actions.deleteScenario(active.id);
                    if (r.ok) {
                      setNote({ ok: true, text: r.note });
                      router.push(
                        dashboardHref(self, { ...params, scenarioId: null }, 'escenarios'),
                        {
                          scroll: false,
                        },
                      );
                    } else setNote({ ok: false, text: r.error });
                  })
                }
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Borrar escenario
              </button>
            </div>
          )}
          {scenarios.data.length === 0 && !building && (
            <p className="text-xs text-ink-muted">
              Todavía no hay escenarios guardados. Arma uno o pídeselo a Cortex en el chat.
            </p>
          )}

          {building && (
            <Builder
              today={today}
              currency={currency}
              counterparties={counterparties}
              onCancel={() => setBuilding(false)}
              onSave={async (label, adjustments) => {
                const r = await actions.saveScenario({ label, adjustments });
                if (r.ok) {
                  setBuilding(false);
                  setNote({ ok: true, text: r.note });
                  router.push(
                    dashboardHref(self, { ...params, scenarioId: r.id ?? null }, 'flujo'),
                    { scroll: false },
                  );
                }
                return r;
              }}
            />
          )}
          <ActionNote note={note} />
        </div>
      )}
    </Section>
  );
}

function chip(active: boolean) {
  return clsx(
    'inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-semibold transition-colors',
    active
      ? 'border-primary bg-primary text-white'
      : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
  );
}

const KINDS = Object.keys(DRAFT_KIND_LABEL) as DraftKind[];

function Builder({
  today,
  currency,
  counterparties,
  onCancel,
  onSave,
}: {
  today: string;
  currency: string;
  counterparties: string[];
  onCancel: () => void;
  onSave: (
    label: string,
    adjustments: ScenarioAdjustment[],
  ) => Promise<{ ok: true; note: string } | { ok: false; error: string }>;
}) {
  const listId = useId();
  const [label, setLabel] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([emptyDraft('delay_counterparty', today)]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const results = rows.map(draftToAdjustment);
  const valid = results.flatMap((r) => (r.ok ? [r.adjustment] : []));
  const sentence =
    valid.length > 0
      ? describeScenario(
          { id: 'borrador', label: label.trim() || 'Nuevo', adjustments: valid },
          currency,
        )
      : null;
  const patch = (i: number, p: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <form
      className="space-y-3 rounded-card border border-border bg-surface-2/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const bad = results.find((r) => !r.ok);
        if (bad && !bad.ok) return setError(bad.error);
        if (!label.trim()) return setError('Ponle un nombre al escenario.');
        start(async () => {
          const r = await onSave(label.trim(), valid);
          if (!r.ok) setError(r.error);
        });
      }}
    >
      <datalist id={listId}>
        {counterparties.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <label className="block">
        <span className="field-label text-ink-faint">Nombre del escenario</span>
        <input
          className={`${fieldClass} mt-1`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Nexa se atrasa"
          maxLength={80}
        />
      </label>

      <ol className="space-y-2">
        {rows.map((row, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen identidad propia; se quitan por posición.
            key={i}
            className="grid gap-2 rounded-sm border border-border bg-surface p-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]"
          >
            <label className="block">
              <span className="sr-only">Tipo de cambio {i + 1}</span>
              <select
                className={fieldClass}
                value={row.kind}
                onChange={(e) => {
                  const kind = e.target.value as DraftKind;
                  patch(i, { ...emptyDraft(kind, today), counterparty: row.counterparty });
                }}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DRAFT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <RowFields row={row} listId={listId} onChange={(p) => patch(i, p)} />
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              disabled={rows.length === 1}
              aria-label={`Quitar el cambio ${i + 1}`}
              className="grid h-10 w-10 place-items-center self-end rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      {rows.length < 12 && (
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, emptyDraft('one_off', today)])}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Otro cambio
        </button>
      )}

      <p className="rounded-sm bg-surface px-3 py-2 text-sm text-ink" aria-live="polite">
        {sentence ?? 'Completa el cambio para ver cómo se lee.'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-rose">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={pillPrimary} disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar y ver en el flujo'}
        </button>
        <button type="button" className={pillLink} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function RowFields({
  row,
  listId,
  onChange,
}: {
  row: DraftRow;
  listId: string;
  onChange: (p: Partial<DraftRow>) => void;
}) {
  const direction = (
    <label className="block">
      <span className="sr-only">Sentido</span>
      <select
        className={fieldClass}
        value={row.direction}
        onChange={(e) => onChange({ direction: e.target.value as 'in' | 'out' })}
      >
        <option value="out">Sale (gasto)</option>
        <option value="in">Entra (ingreso)</option>
      </select>
    </label>
  );
  const amount = (
    <label className="block">
      <span className="sr-only">Monto</span>
      <input
        className={`${fieldClass} tabular font-mono`}
        value={row.amount}
        onChange={(e) => onChange({ amount: e.target.value })}
        placeholder="Monto: 2.500.000"
        inputMode="decimal"
      />
    </label>
  );
  const name = (
    <label className="block">
      <span className="sr-only">Cliente</span>
      <input
        className={fieldClass}
        value={row.counterparty}
        list={listId}
        onChange={(e) => onChange({ counterparty: e.target.value })}
        placeholder="Cliente: Nexa"
      />
    </label>
  );
  const what = (
    <label className="block">
      <span className="sr-only">Qué es</span>
      <input
        className={fieldClass}
        value={row.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Qué es: Contratar conductor"
      />
    </label>
  );
  const date = (label: string) => (
    <label className="block">
      <span className="sr-only">{label}</span>
      <input
        type="date"
        className={`${fieldClass} tabular font-mono`}
        value={row.date}
        onChange={(e) => onChange({ date: e.target.value })}
      />
    </label>
  );

  switch (row.kind) {
    case 'delay_counterparty':
      return (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
          {name}
          <label className="flex items-center gap-2">
            <span className="sr-only">Días de atraso</span>
            <input
              type="number"
              min={1}
              max={365}
              className={`${fieldClass} tabular font-mono`}
              value={row.days}
              onChange={(e) => onChange({ days: e.target.value })}
            />
            <span className="text-xs text-ink-muted">días</span>
          </label>
        </div>
      );
    case 'drop_counterparty':
      return name;
    case 'add_recurring':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {what}
          {direction}
          {amount}
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="sr-only">Cada cuánto</span>
              <select
                className={fieldClass}
                value={row.every}
                onChange={(e) => onChange({ every: e.target.value as 'week' | 'month' })}
              >
                <option value="month">Cada mes</option>
                <option value="week">Cada semana</option>
              </select>
            </label>
            {date('Desde')}
          </div>
        </div>
      );
    case 'scale_category':
      return (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <label className="block">
            <span className="sr-only">Categoría</span>
            <select
              className={fieldClass}
              value={row.category}
              onChange={(e) => onChange({ category: e.target.value })}
            >
              {LEDGER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="sr-only">Cambio en porcentaje (negativo baja)</span>
            <input
              type="number"
              min={-100}
              max={500}
              className={`${fieldClass} tabular font-mono`}
              value={row.percent}
              onChange={(e) => onChange({ percent: e.target.value })}
            />
            <span className="text-xs text-ink-muted">%</span>
          </label>
        </div>
      );
    case 'one_off':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {what}
          {direction}
          {amount}
          {date('Fecha')}
        </div>
      );
  }
}
