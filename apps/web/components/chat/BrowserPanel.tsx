'use client';

import { type BrowserStep, isBrowserTool } from '@/lib/browser-live-steps';
import { buildActivityRows } from '@/lib/chat-turn';
import { previewOf } from '@/lib/computer-view';
import { clsx } from 'clsx';
import { AlertCircle, Check, Globe, Hand, Loader2, Monitor, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatArtifacts } from './ChatArtifacts';
import { useChatCompose } from './ChatCompose';
import { BrowserPanelScreen } from './results/BrowserLive';

/**
 * LA PESTAÑA «NAVEGADOR» DEL PANEL: LA PANTALLA EN VIVO Y LO QUE SE HIZO EN ELLA.
 *
 * La pantalla es la misma del dock (mismo stream, mismo volante, mismos
 * secretos); aquí sólo se acomoda a lo ancho del panel. Debajo, la línea de
 * pasos sale de las invocaciones del chat, sin protocolo nuevo.
 */

const clock = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'America/Bogota',
});

const GROUPED = new Set(['browser_act', 'browser_read_page']);

interface PlanItem {
  id: string;
  label: string;
  detail: string;
  status: 'ok' | 'error' | 'waiting' | 'running';
}

function StatusIcon({ status }: { status: PlanItem['status'] }) {
  return (
    <span aria-hidden className="mt-0.5 shrink-0">
      {status === 'error' ? (
        <AlertCircle className="h-4 w-4 text-rose" />
      ) : status === 'running' ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
      ) : status === 'waiting' ? (
        <Hand className="h-4 w-4 text-amber" />
      ) : (
        <Check className="h-4 w-4 text-emerald" />
      )}
    </span>
  );
}

/**
 * El plan de la tarea, como la lista de Manus: lo que Cortex va haciendo en
 * este turno, sacado de sus llamadas a medida que llegan (no hay una
 * herramienta de plan: no se inventan pasos futuros). Lo hecho se pliega.
 */
export function PlanChecklist() {
  const api = useChatArtifacts();
  const invocations = api?.turn?.invocations ?? [];
  const items = useMemo<PlanItem[]>(() => {
    const rows = buildActivityRows(invocations, undefined);
    const out: PlanItem[] = [];
    let group: { item: PlanItem; n: number } | null = null;
    rows.forEach((r, i) => {
      const tool = (invocations[i]?.toolName ?? '').replaceAll('.', '_');
      if (GROUPED.has(tool)) {
        if (group) {
          group.n += 1;
          group.item.status =
            r.status === 'ok' && group.item.status !== 'ok' ? group.item.status : r.status;
          group.item.id = r.id;
          group.item.detail = `${group.n} pasos`;
        } else {
          group = {
            item: { id: r.id, label: 'Navegar en la página', detail: '1 paso', status: r.status },
            n: 1,
          };
          out.push(group.item);
        }
        return;
      }
      group = null;
      out.push({ id: r.id, label: r.name, detail: r.summary, status: r.status });
    });
    return out;
  }, [invocations]);
  if (items.length === 0) return null;
  const firstOpen = items.findIndex((it) => it.status !== 'ok');
  const foldUntil = firstOpen === -1 ? Math.max(0, items.length - 2) : Math.max(0, firstOpen - 1);
  const folded = items.slice(0, foldUntil);
  const shown = items.slice(foldUntil);
  const doneCount = items.filter((it) => it.status === 'ok').length;
  const row = (it: PlanItem) => (
    <li key={it.id} className="flex items-start gap-2.5 py-1.5">
      <StatusIcon status={it.status} />
      <div className="min-w-0 flex-1">
        <p
          className={clsx(
            'text-sm leading-snug [overflow-wrap:anywhere]',
            it.status === 'error' ? 'font-medium text-rose' : 'text-ink',
          )}
        >
          {it.label}
        </p>
        {it.detail && (
          <p className="truncate text-xs text-ink-faint" title={it.detail}>
            {it.detail}
          </p>
        )}
      </div>
    </li>
  );
  return (
    <section
      aria-label="Plan de la tarea"
      className="rounded-card border border-border bg-surface-2/50 px-3 py-2"
    >
      <h3 className="flex items-center justify-between text-xs font-semibold tracking-wide text-ink-faint uppercase">
        Plan
        <span className="tabular font-normal tracking-normal normal-case">
          {doneCount} de {items.length} hechos
        </span>
      </h3>
      {folded.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer py-1 text-xs font-medium text-ink-muted">
            {folded.length} {folded.length === 1 ? 'paso hecho' : 'pasos hechos'}
          </summary>
          <ul className="flex flex-col">{folded.map(row)}</ul>
        </details>
      )}
      <ul className="flex flex-col">{shown.map(row)}</ul>
    </section>
  );
}

/**
 * La pantalla cuando el paso NO es navegar: qué hace Cortex ahora (leer un
 * documento, consultar un sistema) y, si ya hay resultado, una tablita.
 */
export function ComputerFrame() {
  const api = useChatArtifacts();
  const invocations = api?.turn?.invocations ?? [];
  const last = invocations[invocations.length - 1];
  if (!last) return null;
  const row = buildActivityRows([last], undefined)[0];
  if (!row) return null;
  const preview = last.state === 'result' ? previewOf(last.result) : null;
  return (
    <section
      aria-label="Lo que hace Cortex"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-ink-muted">
          <Monitor className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink [overflow-wrap:anywhere]">
            {row.status === 'running' ? `Cortex está trabajando: ${row.name}` : row.name}
          </p>
          {row.summary && (
            <p className="mt-0.5 text-xs text-ink-muted [overflow-wrap:anywhere]">{row.summary}</p>
          )}
          {preview && (
            <p className="mt-0.5 text-xs text-ink-faint">
              {preview.count} {preview.count === 1 ? 'resultado' : 'resultados'}
            </p>
          )}
        </div>
        {row.status === 'running' && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
        )}
      </div>
      {preview && (
        <div className="scroll-slim overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr>
                {preview.headers.map((h) => (
                  <th key={h} className="px-2.5 py-1.5 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-ink">
              {preview.rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: vista previa fija, sin reordenar.
                <tr key={i}>
                  {r.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: vista previa fija.
                    <td key={j} className="max-w-[12rem] truncate px-2.5 py-1.5">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** La repetición: el cuadro de un paso pasado, con su foto si la hubo o su tarjeta. */
function ReplayFrame({ step }: { step: BrowserStep }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-surface-2 p-3">
      {step.thumb ? (
        <img
          src={step.thumb}
          alt={step.sentence}
          className="w-full rounded-lg border border-border object-contain"
        />
      ) : (
        <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-ink-muted">
          Este paso no dejó una foto de la pantalla.
        </div>
      )}
      <p
        className={clsx(
          'text-sm [overflow-wrap:anywhere]',
          step.status === 'error' ? 'font-medium text-rose' : 'text-ink',
        )}
      >
        {step.sentence}
        {step.at ? (
          <span className="ml-2 font-mono text-micro text-ink-faint">{clock.format(step.at)}</span>
        ) : null}
      </p>
    </div>
  );
}

export function StepTimeline({
  steps,
  selected,
  onSelect,
}: { steps: BrowserStep[]; selected: string | null; onSelect: (id: string) => void }) {
  const picked = useRef<HTMLLIElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando cambia el paso marcado.
  useEffect(() => {
    picked.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  if (steps.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border px-4 py-5 text-sm text-ink-muted">
        Cuando Cortex navegue, cada paso aparece aquí.
      </p>
    );
  }
  return (
    <section aria-label="Pasos en el navegador">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Pasos</h3>
      <ol aria-live="polite" className="flex flex-col divide-y divide-border">
        {steps.map((s) => (
          <li
            key={s.id}
            id={`browser-step-${s.id}`}
            ref={selected === s.id ? picked : undefined}
            className={clsx(selected === s.id && '-mx-2 rounded-lg bg-primary-soft px-2')}
          >
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-current={selected === s.id}
              className="flex w-full items-start gap-3 py-2.5 text-left"
            >
              <StatusIcon status={s.needsPerson ? 'waiting' : s.status} />
              <div className="min-w-0 flex-1">
                <p
                  className={clsx(
                    'text-sm leading-snug [overflow-wrap:anywhere]',
                    s.status === 'error' ? 'font-medium text-rose' : 'text-ink',
                  )}
                >
                  {s.sentence}
                </p>
                {s.thumb && (
                  <img
                    src={s.thumb}
                    alt=""
                    loading="lazy"
                    className="mt-1.5 h-16 w-28 rounded-md border border-border object-cover object-top"
                  />
                )}
              </div>
              {s.at ? (
                <time
                  dateTime={new Date(s.at).toISOString()}
                  className="tabular shrink-0 pt-0.5 font-mono text-micro text-ink-faint"
                >
                  {clock.format(s.at)}
                </time>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function BrowserTabPanel() {
  const api = useChatArtifacts();
  const compose = useChatCompose();
  // null = en vivo; un número = repitiendo ese paso.
  const [scrub, setScrub] = useState<number | null>(null);
  const focusStep = api?.focusStep ?? null;
  const steps = api?.steps ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo cuando otra pestaña marca un paso.
  useEffect(() => {
    if (!focusStep) return;
    const i = steps.findIndex((s) => s.id === focusStep);
    if (i !== -1) setScrub(i);
  }, [focusStep]);
  if (!api) return null;
  const { live } = api;
  const running = [...steps].reverse().find((s) => s.status === 'running');
  const lastInv = api.turn?.invocations[api.turn.invocations.length - 1];
  const browsingNow = !lastInv || isBrowserTool(lastInv.toolName);
  const replaying = scrub !== null && steps[scrub];
  return (
    <div className="flex flex-col gap-5">
      <PlanChecklist />
      {!browsingNow || !live ? <ComputerFrame /> : null}
      {live ? (
        <div className={replaying ? 'hidden' : undefined}>
          <BrowserPanelScreen
            tab={live}
            {...(compose ? { onSay: compose.ask } : {})}
            options={{
              ...(running ? { status: running.doing } : {}),
              onStopped: api.stopLive,
              ...(live.fixture ? { fixture: live.fixture } : {}),
            }}
          />
        </div>
      ) : steps.length > 0 ? (
        <p className="flex items-center gap-2 rounded-card border border-dashed border-border px-4 py-5 text-sm text-ink-muted">
          <Globe className="h-4 w-4 shrink-0" aria-hidden />
          La pestaña se cerró. Aquí queda lo que se hizo en ella.
        </p>
      ) : null}
      {replaying && steps[scrub] ? <ReplayFrame step={steps[scrub]} /> : null}
      {steps.length > 1 && (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={steps.length - 1}
            value={scrub ?? steps.length - 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              setScrub(v >= steps.length - 1 && live ? null : v);
            }}
            aria-label="Repetir los pasos"
            aria-valuetext={steps[scrub ?? steps.length - 1]?.sentence}
            className="min-w-0 flex-1 accent-[rgb(var(--primary))]"
          />
          {replaying ? (
            <button
              type="button"
              onClick={() => setScrub(null)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3 text-xs font-semibold text-white"
            >
              <Play className="h-3 w-3" aria-hidden /> Volver a en vivo
            </button>
          ) : (
            <span className="shrink-0 text-xs text-ink-faint">
              {live ? 'En vivo' : 'Repetición'}
            </span>
          )}
        </div>
      )}
      <StepTimeline
        steps={steps}
        selected={replaying ? (steps[scrub]?.id ?? null) : null}
        onSelect={(id) => {
          const i = steps.findIndex((s) => s.id === id);
          if (i !== -1) setScrub(i);
        }}
      />
    </div>
  );
}
