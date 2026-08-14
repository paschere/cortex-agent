'use client';

import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { CalendarCheck2, CalendarDays, Inbox, TriangleAlert, Users } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  acknowledgeCommitment,
  confirmCommitment,
  fulfilCommitment,
  rejectCommitment,
} from '../actions';
import { CommitmentCard, ProposalCard } from './CommitmentCard';
import { NewCommitmentButton } from './NewCommitment';
import { PeopleBoard } from './PeopleBoard';
import type { CommitmentView, PeopleLoad } from './types';

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
 *
 * ===========================================================================
 * UN MODO, NO UNA PESTAÑA
 * ===========================================================================
 * «Por fecha» y «por persona» son las MISMAS filas leídas de dos maneras, no
 * dos pantallas. Con una pestaña habría que decidir otra vez qué se carga, qué
 * pasa cuando está vacía y qué encabezado lleva — tres decisiones duplicadas
 * que se van separando hasta que una pestaña dice «3 vencidos» y la otra «4».
 * Con un modo hay una sola consulta, un solo `today` y un solo estado vacío, y
 * cambiar de lente no cuesta un viaje al servidor.
 *
 * ARRANCA EN «POR FECHA» a propósito, aunque la vista nueva sea la de persona:
 * lo más caro que sabe este producto es un SOAT vencido — el camión está en la
 * vía sin seguro AHORA — y eso tiene que seguir siendo lo primero que se ve al
 * abrir. Cuando hay promesas atrasadas, el propio modo por fecha lo dice y
 * ofrece el cambio; una vista que hay que descubrir no la usa nadie.
 */

type Filter = 'todos' | 'soat' | 'rtm' | 'contract' | 'policy' | 'customs' | 'payment';

/** Cómo se está leyendo la lista: por cuándo vence, o por quién responde. */
type Mode = 'fecha' | 'persona';

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
  load,
}: {
  overdue: CommitmentView[];
  dueSoon: CommitmentView[];
  inForce: CommitmentView[];
  pending: CommitmentView[];
  people: Array<{ id: string; name: string }>;
  /** Las mismas filas abiertas, ya agrupadas por responsable en el servidor. */
  load: PeopleLoad;
}) {
  const [mode, setMode] = useState<Mode>('fecha');
  const [filter, setFilter] = useState<Filter>('todos');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // El aviso que lleva a la otra lente. Se cuenta sobre el modelo que ya bajó
  // resuelto — aquí no se deriva ningún estado.
  const latePromisers = load.pending.filter((p) => !p.unassigned && p.promises.overdue > 0);
  const latePromises = latePromisers.reduce((n, p) => n + p.promises.overdue, 0);

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
          className="rounded-card border border-rose/25 bg-rose-soft px-4 py-3 text-sm text-rose"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Sin `role="group"`: cada botón ya dice qué es y si está puesto con
            `aria-pressed`, y la agrupación no añade nada que se lea en voz alta. */}
        <div className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface p-1 shadow-card">
          <ModeButton
            active={mode === 'fecha'}
            onClick={() => setMode('fecha')}
            icon={<CalendarDays className="h-3.5 w-3.5" aria-hidden />}
            label="Por fecha"
          />
          <ModeButton
            active={mode === 'persona'}
            onClick={() => setMode('persona')}
            icon={<Users className="h-3.5 w-3.5" aria-hidden />}
            label="Por persona"
          />
        </div>

        {mode === 'fecha' &&
          FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={clsx(
                'rounded-pill px-3 py-1.5 text-xs font-semibold transition-all duration-150',
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

      {mode === 'fecha' && latePromises > 0 && (
        <button
          type="button"
          onClick={() => setMode('persona')}
          className="flex w-full items-center gap-2 rounded-card border border-border bg-surface-2 px-4 py-2.5 text-left text-xs text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <Users className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <span>
            <span className="font-semibold text-ink">
              {latePromises === 1
                ? '1 promesa pasada de fecha'
                : `${latePromises} promesas pasadas de fecha`}
            </span>{' '}
            {latePromisers.length === 1
              ? 'de una persona. Entre las fechas de la flota no se ven.'
              : `repartidas entre ${latePromisers.length} personas. Entre las fechas de la flota no se ven.`}
          </span>
          <span className="ml-auto shrink-0 font-semibold text-primary">Verlo por persona →</span>
        </button>
      )}

      {pending.length > 0 && (
        <Panel className="border-amber/25 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Inbox className="h-4 w-4 text-amber" aria-hidden />
            <h2 className="text-sm font-semibold text-ink">Esperando que alguien confirme</h2>
            <span className="tabular text-xs text-ink-faint">({pending.length})</span>
          </div>
          <p className="mb-4 max-w-2xl text-xs leading-snug text-ink-muted">
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

      {mode === 'persona' ? (
        <PeopleBoard load={load} />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

/** Una de las dos lentes. Segmentado, no pestaña: es la misma lista. */
function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-semibold transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'motion-reduce:transition-none',
        active ? 'bg-primary text-white' : 'text-ink-muted hover:text-ink',
      )}
    >
      {icon}
      {label}
    </button>
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
        <span className="tabular text-xs text-ink-faint">({count})</span>
        {collapsedByDefault && count > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto rounded-pill px-2.5 py-1 text-xs font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            {open ? 'Ocultar' : 'Mostrar'}
          </button>
        )}
      </div>

      {count === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
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
