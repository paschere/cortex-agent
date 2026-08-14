'use client';

import { type SavedFlow, TeachFlow } from '@/components/browser/TeachFlow';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { type FlowSummary, MODULE } from '@/lib/browser-shape';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, Video, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Health, health } from '../_lib/flow-view';
import { Flows } from './Flows';

/**
 * The shelf of learned errands, and the one question it exists to answer.
 *
 * ---------------------------------------------------------------------------
 * WHAT SOMEBODY COMES HERE TO FIND OUT
 * ---------------------------------------------------------------------------
 * Not "what can Cortex do" — "WHICH OF THESE CAN I TRUST TO RUN WITHOUT ME".
 * Everything above the list is built to answer that in one look: how many are
 * proven, how many are still a reading of a recording, and how many are in
 * trouble right now. The list underneath is sorted by that same question, so
 * the row that needs a decision is never below the fold.
 *
 * The screen used to open with the teaching form, permanently expanded, on
 * every visit forever — a screen whose job on visit two onwards is inventory
 * greeting you with a five-block form. Teaching is one button here, and it is
 * the loud one; the panel only unfolds when somebody asks for it.
 *
 * ---------------------------------------------------------------------------
 * THE EMPTY SCREEN IS THE MAIN SCREEN
 * ---------------------------------------------------------------------------
 * A workspace has zero trámites for its first weeks, so the empty case is not
 * a degraded list — it IS the product for as long as it lasts, and it gets the
 * whole surface: the teaching panel opened, with the explanation of what a
 * recording captures and what it does not. There is no stat strip over four
 * zeros, no filter chips over nothing, and no separate "todavía no hay nada"
 * panel repeating the sentence the panel below it already says.
 */

type Filter = 'todos' | 'probados' | 'propuestos' | 'problema' | 'sin-cuenta';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'problema', label: 'Con problema' },
  { id: 'probados', label: 'Probados' },
  { id: 'propuestos', label: 'Propuestos' },
  // Un grupo aparte porque su arreglo es distinto de todos los demás: no hay
  // nada que corregir en los pasos, falta un dato que sólo tiene una persona.
  { id: 'sin-cuenta', label: 'Sin cuenta' },
];

const MATCHES: Record<Filter, (flow: FlowSummary, h: Health) => boolean> = {
  todos: () => true,
  problema: (_flow, h) => h === 'trouble',
  probados: (_flow, h) => h === 'proven',
  propuestos: (_flow, h) => h === 'proposed',
  'sin-cuenta': (flow) => flow.needsCredential,
};

interface Notice {
  tone: 'emerald' | 'amber';
  text: string;
}

export function Surface() {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('todos');
  const [teaching, setTeaching] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/browser/flows');
    const payload = (await response.json()) as { flows?: FlowSummary[] };
    setFlows(payload.flows ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const all = flows ?? [];
    let proven = 0;
    let proposed = 0;
    let trouble = 0;
    for (const flow of all) {
      const h = health(flow);
      if (h === 'proven') proven += 1;
      else if (h === 'proposed') proposed += 1;
      else trouble += 1;
    }
    return {
      proven,
      proposed,
      trouble,
      credential: all.filter((f) => f.hasCredential).length,
      needsCredential: all.filter((f) => f.needsCredential).length,
    };
  }, [flows]);

  const visible = useMemo(
    () => (flows ?? []).filter((flow) => MATCHES[filter](flow, health(flow))),
    [flows, filter],
  );

  const onSaved = useCallback(
    (saved: SavedFlow) => {
      setNotice({ tone: saved.verified ? 'emerald' : 'amber', text: saved.message });
      setTeaching(false);
      void load();
    },
    [load],
  );

  if (flows === null) {
    return (
      <Panel className="flex items-center gap-2 p-6">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
        <span className="text-sm text-ink-muted">Cargando…</span>
      </Panel>
    );
  }

  // First run. The teaching panel is the page, not a block above an apology.
  if (flows.length === 0) {
    return (
      <>
        {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
        <TeachFlow first onSaved={onSaved} />
      </>
    );
  }

  return (
    <>
      {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}

      {/* Hairlines come from the gap showing the border colour through, so the
          rules stay correct at every breakpoint the grid reflows to. */}
      <Panel className="mb-5 grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <Stat
          label="Probados"
          value={counts.proven}
          tone={counts.proven > 0 ? 'emerald' : 'ink'}
          sub={counts.proven > 0 ? 'se pueden programar' : 'ninguno reproduce todavía'}
        />
        <Stat
          label="Con problema"
          value={counts.trouble}
          tone={counts.trouble > 0 ? 'rose' : 'ink'}
          sub={counts.trouble > 0 ? 'revísalos antes de contar con ellos' : 'ninguno se ha roto'}
        />
        <Stat
          label="Propuestos"
          value={counts.proposed}
          tone={counts.proposed > 0 ? 'amber' : 'ink'}
          sub={counts.proposed > 0 ? 'nadie los ha visto funcionar' : 'todos reprodujeron'}
        />
        {/* El cuarto contador solía ser inerte: decía cuántos guardan una clave,
            que no es una pregunta que nadie tenga. La que sí se tiene es la
            contraria — a cuántos les falta —, porque ésos no fallan, se
            detienen a preguntar, y la respuesta la tiene una persona. */}
        <Stat
          label={counts.needsCredential > 0 ? 'Sin cuenta' : 'Con credencial'}
          value={counts.needsCredential > 0 ? counts.needsCredential : counts.credential}
          tone={counts.needsCredential > 0 ? 'amber' : 'ink'}
          sub={
            counts.needsCredential > 0
              ? 'el portal les pide entrar y no tienen con qué'
              : counts.credential > 0
                ? 'entran con una clave de la empresa'
                : 'ninguno guarda una clave'
          }
        />
      </Panel>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
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
          <Button onClick={() => setTeaching((open) => !open)} aria-expanded={teaching}>
            <Video className="h-4 w-4" aria-hidden="true" />
            Enseñar un {MODULE.one}
          </Button>
        </div>
      </div>

      {teaching && (
        <div className="mb-5">
          <TeachFlow onSaved={onSaved} onCancel={() => setTeaching(false)} />
        </div>
      )}

      <Flows flows={visible} total={flows.length} filtered={filter !== 'todos'} onChanged={load} />
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub: string;
  tone: 'emerald' | 'amber' | 'rose' | 'ink';
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="field-label truncate">{label}</div>
      <div
        className={clsx(
          'stat-num mt-1 text-xl leading-none',
          tone === 'rose'
            ? 'text-rose'
            : tone === 'amber'
              ? 'text-amber'
              : tone === 'emerald'
                ? 'text-emerald'
                : 'text-ink',
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 line-clamp-2 text-micro leading-snug text-ink-faint">{sub}</div>
    </div>
  );
}

/**
 * What happened to the thing you just taught. Amber rather than emerald when
 * it saved but did not reproduce — the difference between propuesto and
 * probado is the whole screen, and a green tick over "no reproduce" would
 * teach people to stop reading it.
 */
function NoticeBanner({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const good = notice.tone === 'emerald';
  return (
    <div
      className={clsx(
        'mb-5 flex items-start gap-2 rounded-card border px-4 py-3',
        good ? 'border-emerald/20 bg-emerald-soft' : 'border-amber/20 bg-amber-soft',
      )}
    >
      {good ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden="true" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
      )}
      <p className="flex-1 text-sm leading-relaxed text-ink">{notice.text}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar el aviso"
        className="-mr-1 -mt-1 shrink-0 rounded-pill p-1 text-ink-faint transition-colors duration-150 hover:bg-surface/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
