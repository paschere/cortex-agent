'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { ago, hours, num } from './format';
import type { BrainStats, DigestStage } from './types';

/**
 * The machine panel.
 *
 * WHAT IT IS FOR. A document is not an answer until it has been read, chopped
 * and vectorised, and until then Cortex will swear it does not know a thing
 * that is sitting right there in the list. The old page called that `status:
 * pending` and left the person to guess. This shows the belt: what has just
 * gone in, what is being worked on right now, and what has come out the other
 * side as something quotable.
 *
 * It polls while anything is in flight and stops when nothing is, so the
 * figures move on their own exactly when there is something to see and the tab
 * is idle the rest of the time. The one flourish — a wash of green when the
 * remembered count goes up — is the moment the whole page exists for.
 */

const QUERY_KEY = ['kb-digest'] as const;

async function fetchDigest(): Promise<BrainStats> {
  const r = await fetch('/api/kb/documents?digest=1');
  const j = (await r.json()) as { stats?: BrainStats };
  if (!j.stats) throw new Error('sin datos');
  return j.stats;
}

const STAGES: Array<{
  key: DigestStage;
  label: string;
  hint: string;
  bar: string;
  dot: string;
  text: string;
}> = [
  {
    key: 'waiting',
    label: 'Entra',
    hint: 'esperan turno',
    bar: 'bg-amber',
    dot: 'bg-amber',
    text: 'text-amber',
  },
  {
    key: 'digesting',
    label: 'Se digiere',
    hint: 'leyendo y troceando',
    bar: 'bg-primary',
    dot: 'bg-primary',
    text: 'text-primary',
  },
  {
    key: 'memory',
    label: 'Ya lo recuerda',
    hint: 'Cortex puede citarlo',
    bar: 'bg-emerald',
    dot: 'bg-emerald',
    text: 'text-emerald',
  },
  {
    key: 'stuck',
    label: 'Atascado',
    hint: 'no se pudo leer',
    bar: 'bg-rose',
    dot: 'bg-rose',
    text: 'text-rose',
  },
];

export function useDigest(initial: BrainStats) {
  const qc = useQueryClient();

  // A server refresh (an upload, a deletion) is the truth; adopt it and let the
  // poll carry on from there instead of the two sources arguing.
  useEffect(() => {
    qc.setQueryData(QUERY_KEY, initial);
  }, [initial, qc]);

  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchDigest,
    initialData: initial,
    refetchInterval: (query) => {
      const s = query.state.data;
      if (!s) return false;
      return s.stages.waiting + s.stages.digesting > 0 ? 2500 : false;
    },
  });

  return data ?? initial;
}

export function DigestionPanel({ stats }: { stats: BrainStats }) {
  const inFlight = stats.stages.waiting + stats.stages.digesting;
  const total = STAGES.reduce((sum, s) => sum + stats.stages[s.key], 0);

  // The transition worth noticing: something crossed into memory while you
  // were looking at it.
  const [arrived, setArrived] = useState(false);
  const previous = useRef(stats.stages.memory);
  useEffect(() => {
    if (stats.stages.memory > previous.current) {
      setArrived(true);
      const t = setTimeout(() => setArrived(false), 2600);
      previous.current = stats.stages.memory;
      return () => clearTimeout(t);
    }
    previous.current = stats.stages.memory;
  }, [stats.stages.memory]);

  return (
    <Panel>
      <PanelHead
        title="Digestión"
        right={
          inFlight > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span className="tabular">{num(inFlight)}</span> en proceso
            </span>
          ) : (
            'todo digerido'
          )
        }
      />

      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Nada se puede recordar hasta que termina de pasar por aquí.
      </p>

      {/* Ruled, not boxed: the gap is the hairline, so the columns are divided
          the way a form divides its boxes and it survives the wrap to two
          columns on a phone. */}
      <div className="mt-4 grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
        {STAGES.map((stage) => {
          const value = stats.stages[stage.key];
          const quiet = value === 0;
          const glow = stage.key === 'memory' && arrived;
          return (
            <div
              key={stage.key}
              className={clsx(
                'px-5 py-4 transition-colors duration-1000',
                glow ? 'bg-emerald-soft' : 'bg-surface',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    quiet ? 'bg-border-strong' : stage.dot,
                    !quiet && stage.key === 'digesting' && 'animate-pulse',
                  )}
                />
                <span className="field-label">{stage.label}</span>
              </div>
              <div
                className={clsx(
                  'stat-num mt-1.5 text-[26px] leading-none',
                  quiet ? 'text-ink-faint' : stage.text,
                )}
              >
                {num(value)}
              </div>
              <div className="mt-1 text-[11px] text-ink-faint">{stage.hint}</div>
            </div>
          );
        })}
      </div>

      {/* The belt itself. Proportions, not decoration: this is the same four
          numbers laid end to end so the shape of the backlog is readable at a
          glance. */}
      {total > 0 && (
        <div className="flex h-1.5 w-full overflow-hidden border-t border-border">
          {STAGES.map((stage) => {
            const value = stats.stages[stage.key];
            if (value === 0) return null;
            return (
              <span
                key={stage.key}
                className={clsx('h-full transition-[width] duration-700', stage.bar)}
                style={{ width: `${(value / total) * 100}%` }}
              />
            );
          })}
        </div>
      )}

      <div className="border-t border-border px-5 py-4">
        {stats.digesting.length === 0 ? (
          <p className="text-[12.5px] text-ink-muted">
            {total === 0
              ? 'Todavía no ha comido nada. Dale el primer documento abajo.'
              : stats.stages.stuck > 0
                ? 'No hay nada en proceso. Revisa los atascados: esos no entraron.'
                : 'No hay nada en proceso. Todo lo que entró ya se puede recordar.'}
          </p>
        ) : (
          <>
            <div className="field-label">En proceso ahora</div>
            <ul className="mt-2 space-y-1.5">
              {stats.digesting.slice(0, 4).map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      doc.stage === 'digesting' ? 'animate-pulse bg-primary' : 'bg-amber',
                    )}
                  />
                  <span className="min-w-0 max-w-full truncate text-[12.5px] font-medium text-ink">
                    {doc.title}
                  </span>
                  <span className="text-[11.5px] text-ink-faint">
                    {doc.transcribing
                      ? 'transcribiendo'
                      : doc.stage === 'digesting'
                        ? 'leyendo'
                        : 'en cola'}
                    {doc.spaceName ? ` · ${doc.spaceName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            {stats.digesting.length > 4 && (
              <p className="mt-2 text-[11.5px] text-ink-faint">
                y <span className="tabular">{num(stats.digesting.length - 4)}</span> más en la fila.
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * What the brain knows, in figures it can prove.
 *
 * Every line is a count of rows. `chunks` comes back null when the count could
 * not be read, and then the line simply is not printed — a figure this page
 * cannot stand behind is worse than a missing one.
 */
export function KnowsPanel({ stats }: { stats: BrainStats }) {
  return (
    <Panel>
      <PanelHead title="Cuánto sabe" />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Contado ahora, sobre lo que ya digirió.
      </p>

      <dl className="mt-3 divide-y divide-border border-t border-border">
        {stats.chunks !== null && (
          <Figure
            label="Fragmentos recordables"
            value={num(stats.chunks)}
            hint="trozos que puede citar uno por uno"
          />
        )}
        <Figure
          label="Horas escuchadas"
          value={hours(stats.spokenSeconds)}
          hint="grabaciones y reuniones ya digeridas"
        />
        <Figure
          label="Personas que reconoce"
          value={num(stats.namedVoices)}
          hint={
            stats.unnamedRecordings > 0
              ? `${num(stats.unnamedRecordings)} grabaciones con voces sin nombre`
              : 'nombres que oyó en reuniones y llamadas'
          }
        />
        <Figure
          label="Último bocado"
          value={stats.lastAddedAt ? ago(stats.lastAddedAt) : '—'}
          hint={stats.lastAddedAt ? 'lo último que entró' : 'nada ha entrado todavía'}
        />
      </dl>
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <dt className="field-label">{label}</dt>
        <dd className="mt-0.5 text-[11px] leading-snug text-ink-faint">{hint}</dd>
      </div>
      <span className="stat-num shrink-0 text-[19px] leading-none text-ink">{value}</span>
    </div>
  );
}
