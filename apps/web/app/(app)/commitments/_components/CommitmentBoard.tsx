'use client';

import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { CalendarCheck2, Inbox, TriangleAlert } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  acknowledgeCommitment,
  confirmCommitment,
  fulfilCommitment,
  rejectCommitment,
} from '../actions';
import { CommitmentCard, ProposalCard } from './CommitmentCard';
import { NewCommitmentButton } from './NewCommitment';
import type { CommitmentView } from './types';

/**
 * The screen, in the order an operations lead actually reads it.
 *
 * VENCIDO FIRST, ALWAYS, and never behind a tab. A lapsed SOAT is the single
 * most expensive thing this product knows about — the truck is on the road
 * uninsured right now — so it is the first block on the page, in rose, with a
 * count, and it does not collapse. Everything else can be filtered; this
 * cannot.
 *
 * The review inbox sits beside it rather than below the whole list, because an
 * unconfirmed proposal is not less urgent than a confirmed one, it is a
 * different kind of task: one asks you to act, the other asks you to decide
 * whether the thing is even true.
 */

type Filter = 'todos' | 'soat' | 'rtm' | 'contract' | 'policy' | 'customs' | 'payment';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'todos', label: 'Todos' },
  { id: 'soat', label: 'SOAT' },
  { id: 'rtm', label: 'Tecnomecánica' },
  { id: 'contract', label: 'Contratos' },
  { id: 'policy', label: 'Pólizas' },
  { id: 'customs', label: 'Aduana' },
  { id: 'payment', label: 'Pagos' },
];

export function CommitmentBoard({
  overdue,
  dueSoon,
  inForce,
  pending,
  people,
}: {
  overdue: CommitmentView[];
  dueSoon: CommitmentView[];
  inForce: CommitmentView[];
  pending: CommitmentView[];
  people: Array<{ id: string; name: string }>;
}) {
  const [filter, setFilter] = useState<Filter>('todos');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const apply = (rows: CommitmentView[]) =>
    filter === 'todos' ? rows : rows.filter((r) => r.kind === filter);

  function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(id);
    setError(null);
    startTransition(async () => {
      const result = await fn();
      setBusyId(null);
      if (!result.ok) setError(result.error ?? 'No se pudo completar la acción.');
    });
  }

  const shownOverdue = apply(overdue);
  const shownSoon = apply(dueSoon);
  const shownForce = apply(inForce);

  return (
    <div className="space-y-5">
      {error && (
        <div
          role="alert"
          className="rounded-card border border-rose/25 bg-rose-soft px-4 py-3 text-[13px] text-rose"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={clsx(
              'rounded-pill px-3 py-1.5 text-[12.5px] font-semibold transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              'motion-reduce:transform-none motion-reduce:transition-none',
              filter === f.id
                ? 'bg-primary text-white shadow-card'
                : 'border border-border bg-surface text-ink-muted hover:-translate-y-px hover:text-ink',
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto">
          <NewCommitmentButton people={people} />
        </div>
      </div>

      {pending.length > 0 && (
        <Panel className="border-amber/25 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Inbox className="h-4 w-4 text-amber" aria-hidden />
            <h2 className="text-sm font-semibold text-ink">Esperando que alguien confirme</h2>
            <span className="tabular text-[12px] text-ink-faint">({pending.length})</span>
          </div>
          <p className="mb-4 max-w-2xl text-[12.5px] leading-snug text-ink-muted">
            Cortex sacó estas fechas de documentos. Ninguna se está vigilando todavía: compara la
            fecha con la frase del documento y confirma sólo lo que sea cierto. Lo que confirmes
            queda a tu nombre.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((c) => (
              <ProposalCard
                key={c.id}
                commitment={c}
                busy={busyId === c.id}
                onConfirm={() => run(c.id, () => confirmCommitment(c.id))}
                onReject={() => run(c.id, () => rejectCommitment(c.id))}
              />
            ))}
          </div>
        </Panel>
      )}

      <Section
        title="Vencido"
        icon={<TriangleAlert className="h-4 w-4 text-rose" aria-hidden />}
        count={shownOverdue.length}
        empty="Nada vencido. Así se ve un mes bien llevado."
        rows={shownOverdue}
        busyId={busyId}
        run={run}
      />

      <Section
        title="Por vencer"
        icon={<CalendarCheck2 className="h-4 w-4 text-amber" aria-hidden />}
        count={shownSoon.length}
        empty="Nada entra en ventana de aviso todavía."
        rows={shownSoon}
        busyId={busyId}
        run={run}
      />

      <Section
        title="Vigente"
        icon={<CalendarCheck2 className="h-4 w-4 text-emerald" aria-hidden />}
        count={shownForce.length}
        empty="No hay más compromisos registrados."
        rows={shownForce}
        busyId={busyId}
        run={run}
        collapsedByDefault
      />
    </div>
  );
}

function Section({
  title,
  icon,
  count,
  empty,
  rows,
  busyId,
  run,
  collapsedByDefault = false,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  empty: string;
  rows: CommitmentView[];
  busyId: string | null;
  run: (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  collapsedByDefault?: boolean;
}) {
  // "Vigente" is the long tail and is folded away by default; the two blocks
  // that need action are never folded.
  const [open, setOpen] = useState(!collapsedByDefault);

  return (
    <Panel className="p-5">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <span className="tabular text-[12px] text-ink-faint">({count})</span>
        {collapsedByDefault && count > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto rounded-pill px-2.5 py-1 text-[12px] font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            {open ? 'Ocultar' : 'Mostrar'}
          </button>
        )}
      </div>

      {count === 0 ? (
        <p className="text-[13px] text-ink-muted">{empty}</p>
      ) : open ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((c) => (
            <CommitmentCard
              key={c.id}
              commitment={c}
              busy={busyId === c.id}
              onFulfil={() => run(c.id, () => fulfilCommitment(c.id))}
              onAcknowledge={() => run(c.id, () => acknowledgeCommitment(c.id))}
            />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
