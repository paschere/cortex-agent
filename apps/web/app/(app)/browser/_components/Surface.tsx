'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { type FlowSummary, MODULE } from '@/lib/browser-shape';
import { clsx } from 'clsx';
import { Globe, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Health, health } from '../_lib/flow-view';
import { Flows } from './Flows';

/** Saved lessons and their replay status. Teaching lives in BrowserWorkspace. */
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

export function Surface() {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('todos');

  const load = useCallback(async () => {
    const response = await fetch('/api/browser/flows');
    const payload = (await response.json()) as { flows?: FlowSummary[] };
    setFlows(payload.flows ?? []);
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => {
      void load();
    };
    window.addEventListener('browser-flows-changed', refresh);
    return () => window.removeEventListener('browser-flows-changed', refresh);
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

  if (flows === null) {
    return (
      <Panel className="flex items-center gap-2 p-6">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
        <span className="text-sm text-ink-muted">Cargando…</span>
      </Panel>
    );
  }

  // The workspace above is the teaching entry even before the first saved flow.
  if (flows.length === 0) {
    return (
      <>
        <p className="py-4 text-sm text-ink-muted">
          Tus trámites aparecerán aquí cuando guardes una enseñanza desde el navegador.
        </p>
      </>
    );
  }

  return (
    <>
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
          <Button
            onClick={() => {
              const workspace = document.getElementById('cortex-browser');
              workspace?.scrollIntoView({ block: 'start' });
              workspace?.focus({ preventScroll: true });
            }}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            Enseñar un {MODULE.one}
          </Button>
        </div>
      </div>

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
