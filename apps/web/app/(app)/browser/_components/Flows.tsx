'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import { DeliveryFields } from '@/components/browser/DeliveryFields';
import {
  ACTION_LABEL,
  DELIVER_TO_LABEL,
  type FlowDelivery,
  type FlowSummary,
  MODULE,
  type ProposedStep,
  STATUS_LABEL,
  STATUS_TONE,
  TARGET_LABEL,
  TARGET_WHY,
} from '@/lib/browser-shape';
import { relativeTime } from '@/lib/relative-time';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Bell, ChevronRight, KeyRound, Loader2, Play, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { health, byUrgency, money, secs, stamp } from '../_lib/flow-view';

/**
 * La biblioteca de trámites aprendidos.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW HAS TO SAY BEFORE IT SAYS ANYTHING ELSE
 * ---------------------------------------------------------------------------
 * 1. Has anybody ever seen this work — probado or propuesto — and when.
 * 2. Did the last run succeed. A trámite that broke and nobody noticed is the
 *    expensive failure of this whole module, so the verdict of the last run is
 *    on the row itself and stays there on a phone. It used to live in a right
 *    rail hidden below the `sm` breakpoint, which is to say it was decoration.
 *
 * The proof is a `<Provenance>` stamp and nothing else is: the host it ran
 * against and the moment it reproduced. A propuesto has no stamp because there
 * is nothing to attest — an empty one would turn the device into decoration.
 * So the presence of the stamp IS the distinction, twice stated with the chip.
 *
 * ---------------------------------------------------------------------------
 * SILENCE IS THE DEFAULT; A MARK MEANS CONSEQUENCE
 * ---------------------------------------------------------------------------
 * A read-only trámite with no credential wears no badge at all. The two marks
 * that exist — a company login, and writing on somebody else's site — appear
 * only when true, so the eye lands on the rows that carry a risk instead of
 * scanning four chips per row to find out none of them meant anything.
 *
 * They are also NOT chips. Emerald / amber / rose are spent on the state of the
 * trámite; the old row painted «Radica o envía» amber beside an amber
 * «Propuesto», which is the same colour meaning two unrelated things a
 * centimetre apart.
 */

interface Detail {
  flow: FlowSummary & {
    steps: ProposedStep[];
    source: string;
    lastError: string | null;
    recordingFrames: number;
    extractionCostUsd: number;
    delivery: FlowDelivery;
  };
  runs: {
    id: string;
    mode: string;
    status: string;
    trigger: string;
    startedAt: string;
    seconds: number | null;
    costUsd: number;
    modelCalls: number;
    failureKind: string | null;
    error: string | null;
    updatedFlow: boolean;
    inputs: Record<string, string>;
  }[];
  trace: Record<string, unknown>[];
  /** What deleting this trámite would take with it. See the DELETE route. */
  removal: Removal;
}

export interface Removal {
  allowed: boolean;
  /** Why not, when `allowed` is false. Said in full, not as a permission code. */
  reason: string | null;
  /** Concrete things that disappear, phrased for a person. */
  losing: string[];
  /** Concrete things that survive it. */
  keeping: string[];
  /** The bound login, if any, and whether anything else still needs it. */
  credential: { label: string; alsoUsedBy: string[] } | null;
  /** Anything pointing at this trámite that would be left aiming at nothing. */
  dependents: string[];
}

export function Flows({
  flows,
  total,
  filtered,
  onChanged,
}: {
  flows: FlowSummary[];
  total: number;
  filtered: boolean;
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ordered = [...flows].sort(byUrgency);

  return (
    <Panel className="overflow-hidden">
      {ordered.length === 0 ? (
        <div className="px-5 py-14 text-center">
          <p className="text-[14px] font-semibold text-ink">Ninguno en este grupo</p>
          <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-snug text-ink-muted">
            {filtered
              ? `Tienes ${total} ${total === 1 ? MODULE.one : MODULE.many} en total. Quita el filtro para verlos.`
              : 'Enseña el primero grabando la pestaña del portal.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {ordered.map((flow) => (
            <Row
              key={flow.id}
              flow={flow}
              open={openId === flow.id}
              onToggle={() => setOpenId(openId === flow.id ? null : flow.id)}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Row({
  flow,
  open,
  onToggle,
  onChanged,
}: {
  flow: FlowSummary;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const state = health(flow);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ChevronRight
          className={clsx(
            'mt-0.5 h-4 w-4 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={chipClass(STATUS_TONE[flow.status])}>
              {STATUS_LABEL[flow.status]}
            </span>
            <span className="min-w-0 truncate text-[14.5px] font-semibold text-ink">
              {flow.name}
            </span>
            <span className="ml-auto shrink-0">
              <LastRun flow={flow} />
            </span>
          </div>

          <p className="mt-1 truncate text-[12.5px] text-ink-muted">
            <span className="font-mono text-[11.5px] text-ink-faint">{flow.site}</span>
            {flow.description && ` · ${flow.description}`}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {/* The proof, or its absence. Never an empty stamp. */}
            {flow.verifiedAt ? (
              <Provenance
                source={flow.site}
                readAt={stamp(flow.verifiedAt)}
                detail={
                  state === 'trouble' ? 'reprodujo, y dejó de hacerlo' : 'reprodujo el trámite entero'
                }
                tone={state === 'trouble' ? 'seal' : 'stamp'}
              />
            ) : (
              <span className="text-[11.5px] font-medium text-amber">
                todavía nadie lo ha visto funcionar
              </span>
            )}

            {flow.hasCredential && (
              <span
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink"
                title="Al correr, entra con una clave guardada de la empresa. Quien lo corre nunca la ve."
              >
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                entra con la clave de la empresa
              </span>
            )}

            {flow.delivery.deliverTo !== 'none' && (
              <span
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink"
                title={
                  flow.delivery.deliverWhen === 'failure'
                    ? 'Te avisa sólo cuando falla.'
                    : 'Te avisa cada vez que corre, salga bien o mal.'
                }
              >
                <Bell className="h-3 w-3" aria-hidden="true" />
                {DELIVER_TO_LABEL[flow.delivery.deliverTo].toLowerCase()}
                {flow.delivery.deliverWhen === 'failure' && ' · sólo si falla'}
              </span>
            )}

            {flow.effect === 'write' && (
              <span
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink"
                title="Escribe en el sitio del tercero, así que desde el chat pide aprobación antes de correr."
              >
                <Send className="h-3 w-3" aria-hidden="true" />
                radica o envía · pide aprobación
              </span>
            )}
          </div>
        </div>
      </button>

      {open && <Expanded flow={flow} onChanged={onChanged} />}
    </li>
  );
}

/** Cuándo corrió por última vez y si salió bien, en una línea. */
function LastRun({ flow }: { flow: FlowSummary }) {
  if (!flow.lastRunAt) {
    return <span className="text-[12px] text-ink-faint">nunca se ha corrido</span>;
  }
  const failed = flow.lastRunStatus === 'failed';
  return (
    <span
      className={clsx(
        'text-[12px]',
        failed ? 'font-semibold text-rose' : 'text-ink-muted',
      )}
    >
      {failed ? 'falló ' : 'corrió bien '}
      <span className="tabular">{relativeTime(flow.lastRunAt)}</span>
      {!failed && flow.lastRunSeconds !== null && (
        <span className="tabular text-ink-faint"> · {secs(flow.lastRunSeconds)}</span>
      )}
    </span>
  );
}

function Expanded({ flow, onChanged }: { flow: FlowSummary; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/browser/flows/${flow.id}`);
    setDetail((await response.json()) as Detail);
  }, [flow.id]);

  useEffect(() => {
    void load();
    const seeded: Record<string, string> = {};
    for (const v of flow.variables) seeded[v.name] = '';
    setInputs(seeded);
  }, [load, flow.variables]);

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);
    const response = await fetch(`/api/browser/flows/${flow.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs }),
    });
    const payload = (await response.json()) as {
      ok: boolean;
      message: string;
      seconds: number;
      costUsd: number;
      modelCalls: number;
    };
    setResult(
      `${payload.message} (${secs(payload.seconds)}, ${
        payload.modelCalls === 0
          ? 'sin llamadas al modelo'
          : `${payload.modelCalls} llamada(s) al modelo, ${money(payload.costUsd)}`
      })`,
    );
    setRunning(false);
    void load();
    onChanged();
  }, [flow.id, inputs, load, onChanged]);

  return (
    <div className="divide-y divide-border border-t border-border bg-surface-2/40">
      {flow.status === 'draft' && (
        <p className="bg-amber-soft/60 px-5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
          Salió de una grabación y todavía <strong className="text-ink">no ha reproducido</strong>.
          Se puede correr a mano desde aquí, pero el agente no lo ve en el chat y no se puede
          programar hasta que funcione una vez completo.
          {flow.lastError && (
            <>
              {' '}
              Lo último que pasó: <span className="text-ink">{flow.lastError}</span>
            </>
          )}
        </p>
      )}
      {flow.status !== 'draft' && flow.lastError && flow.lastRunStatus === 'failed' && (
        <p className="bg-rose-soft/60 px-5 py-3 text-[12.5px] leading-relaxed text-rose">
          {flow.lastError}
        </p>
      )}

      <div className="p-5">
        <h3 className="field-label">Correrlo ahora</h3>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {flow.variables.map((variable) => (
            <div key={variable.name} className="min-w-[160px]">
              <label className="field-label" htmlFor={`in-${flow.id}-${variable.name}`}>
                {variable.label}
              </label>
              <Input
                id={`in-${flow.id}-${variable.name}`}
                className="mt-1"
                value={inputs[variable.name] ?? ''}
                placeholder={variable.example}
                onChange={(e) => setInputs({ ...inputs, [variable.name]: e.target.value })}
              />
            </div>
          ))}
          <Button onClick={() => void run()} disabled={running}>
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {running ? 'Corriendo…' : 'Correr'}
          </Button>
        </div>
        {result && <p className="mt-3 text-[13px] leading-relaxed text-ink">{result}</p>}
      </div>

      {detail && (
        <>
          <div className="p-5">
            <h3 className="field-label">Los pasos · versión {detail.flow.version}</h3>
            <ol className="mt-2 space-y-1.5">
              {detail.flow.steps.map((s, index) => (
                <li key={`${s.label}-${index}`} className="flex flex-wrap items-baseline gap-2">
                  <span className="tabular text-[11px] text-ink-faint">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[13px] text-ink">
                    <span className="text-ink-muted">{ACTION_LABEL[s.action]}</span> {s.label}
                  </span>
                  {s.value?.kind === 'secret' && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink">
                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                      clave guardada
                    </span>
                  )}
                  {s.value?.kind === 'template' && (
                    <code className="font-mono text-[11.5px] text-primary">{s.value.text}</code>
                  )}
                  {s.targets[0] && (
                    <span
                      title={TARGET_WHY[s.targets[0].kind]}
                      className="font-mono text-[10.5px] text-ink-faint"
                    >
                      {TARGET_LABEL[s.targets[0].kind]}
                      {s.targets.length > 1 && ` +${s.targets.length - 1}`}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>

          <div className="p-5">
            <h3 className="field-label">Últimas ejecuciones</h3>
            {detail.runs.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-muted">Todavía no se ha corrido.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {detail.runs.map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-[12.5px]"
                  >
                    <span className="tabular w-[76px] shrink-0 text-ink-faint">
                      {relativeTime(run.startedAt)}
                    </span>
                    <span
                      className={clsx(
                        'min-w-0 flex-1 font-medium',
                        run.status === 'succeeded' ? 'text-emerald' : 'text-rose',
                      )}
                    >
                      {run.status === 'succeeded'
                        ? run.updatedFlow
                          ? 'se reparó solo y funcionó'
                          : 'funcionó'
                        : (FAILURE_LABEL[run.failureKind ?? ''] ?? 'falló')}
                    </span>
                    <span className="text-[11.5px] text-ink-faint">
                      {MODE_LABEL[run.mode] ?? run.mode}
                    </span>
                    <span className="tabular shrink-0 text-[11.5px] text-ink-muted">
                      {run.seconds !== null ? secs(run.seconds) : '—'}
                    </span>
                    <span
                      className={clsx(
                        'tabular w-[86px] shrink-0 text-right text-[11.5px]',
                        run.modelCalls === 0 ? 'text-emerald' : 'text-ink-muted',
                      )}
                      title={
                        run.modelCalls === 0
                          ? 'Repetición pura: ningún modelo participó, así que no costó nada.'
                          : `${run.modelCalls} llamada(s) al modelo`
                      }
                    >
                      {run.modelCalls === 0 ? 'sin costo' : money(run.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {detail.trace.length > 0 && (
            <div className="p-5">
              <h3 className="field-label">Qué hizo, paso a paso, la última vez</h3>
              <ol className="mt-2 space-y-1">
                {detail.trace.map((entry) => (
                  <li
                    key={String(entry.step_index)}
                    className="flex flex-wrap items-baseline gap-2 text-[12px]"
                  >
                    <span className="tabular text-ink-faint">
                      {String(Number(entry.step_index) + 1).padStart(2, '0')}
                    </span>
                    <span className={entry.ok ? 'text-ink' : 'text-rose'}>
                      {String(entry.label)}
                    </span>
                    {entry.value_preview ? (
                      <span className="font-mono text-[11px] text-ink-muted">
                        «{String(entry.value_preview)}»
                      </span>
                    ) : null}
                    {entry.matched_target ? (
                      <span className="font-mono text-[10.5px] text-ink-faint">
                        {String(entry.matched_target)}
                        {Number(entry.matched_rank) > 0 && (
                          // A fallback carried this step. Worth surfacing: it is
                          // the portal changing, early, before it breaks.
                          <span className="text-amber"> (vía alterna)</span>
                        )}
                      </span>
                    ) : null}
                    <span className="tabular ml-auto text-ink-faint">
                      {String(entry.duration_ms)}ms
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <Delivery flowId={flow.id} initial={detail.flow.delivery} onSaved={onChanged} />

          <Remove flow={flow} removal={detail.removal} onRemoved={onChanged} />
        </>
      )}
    </div>
  );
}

/**
 * Cambiar qué produce y dónde llega, después de haberlo enseñado.
 *
 * Written on every change rather than behind a Guardar button: there are four
 * fields, each one is a single click, and a form this small with a save button
 * is a form people leave half-edited. The PATCH only touches the four columns
 * of migration 0093 — the steps and the proof are not editable from here, and
 * that is on purpose.
 */
function Delivery({
  flowId,
  initial,
  onSaved,
}: {
  flowId: string;
  initial: FlowDelivery;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<FlowDelivery>(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const change = useCallback(
    async (next: FlowDelivery) => {
      setValue(next);
      setState('saving');
      const response = await fetch(`/api/browser/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delivery: next }),
      });
      setState(response.ok ? 'saved' : 'idle');
      if (response.ok) onSaved();
    },
    [flowId, onSaved],
  );

  return (
    <div className="p-5">
      <h3 className="field-label">Qué produce y dónde te llega</h3>
      <div className="mt-3">
        <DeliveryFields value={value} onChange={(next) => void change(next)} saving={state} />
      </div>
    </div>
  );
}

/**
 * Borrar un trámite.
 *
 * Two steps, and the second one is not "¿estás seguro?" — it is the list of
 * what stops existing, built by the server from the actual rows, plus the list
 * of what survives. A confirmation that does not name the loss is a speed bump,
 * not a decision.
 */
function Remove({
  flow,
  removal,
  onRemoved,
}: {
  flow: FlowSummary;
  removal: Removal;
  onRemoved: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [dropCredential, setDropCredential] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shared = (removal.credential?.alsoUsedBy.length ?? 0) > 0;
  const blocked = !removal.allowed || removal.dependents.length > 0;

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/browser/flows/${flow.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deleteCredential: dropCredential && !shared }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'No pude eliminarlo. Vuelve a intentarlo.');
      setBusy(false);
      return;
    }
    onRemoved();
  }, [flow.id, dropCredential, shared, onRemoved]);

  if (!asking) {
    return (
      <div className="flex flex-wrap items-center gap-3 p-5">
        <button
          type="button"
          onClick={() => setAsking(true)}
          disabled={!removal.allowed}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-semibold text-rose transition-colors duration-150 hover:bg-rose-soft disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 motion-reduce:transition-none"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Eliminar este {MODULE.one}
        </button>
        {!removal.allowed && removal.reason && (
          <p className="text-[12px] leading-snug text-ink-muted">{removal.reason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-rose-soft/50 p-5">
      <h3 className="text-[13.5px] font-semibold text-ink">
        Eliminar «{flow.name}»
      </h3>

      {removal.dependents.length > 0 && (
        <div className="mt-2.5 rounded-sm border border-amber/20 bg-amber-soft px-3 py-2">
          <p className="text-[12.5px] font-semibold text-amber">
            Hay algo que depende de este {MODULE.one}
          </p>
          <ul className="mt-1 space-y-0.5">
            {removal.dependents.map((d) => (
              <li key={d} className="text-[12.5px] leading-snug text-ink-muted">
                · {d}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
            Quítalo de ahí primero; si no, quedaría apuntando al vacío.
          </p>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="field-label">Se pierde</p>
          <ul className="mt-1.5 space-y-1">
            {removal.losing.map((item) => (
              <li key={item} className="text-[12.5px] leading-snug text-ink">
                · {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="field-label">Se queda</p>
          <ul className="mt-1.5 space-y-1">
            {removal.keeping.map((item) => (
              <li key={item} className="text-[12.5px] leading-snug text-ink-muted">
                · {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {removal.credential && (
        <div className="mt-3 rounded-sm border border-border bg-surface px-3 py-2.5">
          {shared ? (
            <p className="text-[12.5px] leading-snug text-ink-muted">
              <KeyRound className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden="true" />
              La clave <strong className="font-semibold text-ink">
                «{removal.credential.label}»
              </strong>{' '}
              se queda, porque también la usa{' '}
              {removal.credential.alsoUsedBy.join(', ')}.
            </p>
          ) : (
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug text-ink">
              <input
                type="checkbox"
                checked={dropCredential}
                onChange={(e) => setDropCredential(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[rgb(var(--rose))]"
              />
              <span>
                Borrar también la clave{' '}
                <strong className="font-semibold">«{removal.credential.label}»</strong>. No la usa
                ningún otro {MODULE.one}, y dejarla guardada sería una contraseña de la empresa
                cifrada que ya nadie va a gastar.
              </span>
            </label>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-[12.5px] font-medium text-rose">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="danger" onClick={() => void remove()} disabled={busy || blocked}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Eliminar «{flow.name}»
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
          Dejarlo como está
        </Button>
      </div>
    </div>
  );
}

const MODE_LABEL: Record<string, string> = {
  replay: 'repetición',
  reasoned: 'razonado',
  refine: 'ajuste',
  repair: 'reparación',
};

const FAILURE_LABEL: Record<string, string> = {
  transient: 'problema del sitio',
  legitimate: 'el portal lo rechazó',
  'site-changed': 'el portal cambió',
};
