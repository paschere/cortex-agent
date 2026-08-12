'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import {
  ACTION_LABEL,
  EFFECT_LABEL,
  type FlowSummary,
  type ProposedStep,
  STATUS_LABEL,
  STATUS_TONE,
  TARGET_LABEL,
  TARGET_WHY,
} from '@/lib/browser-shape';
import { relativeTime } from '@/lib/relative-time';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ChevronRight, KeyRound, Loader2, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * La biblioteca de trámites aprendidos.
 *
 * THE ONE THING THIS SCREEN MUST NEVER LET YOU MISREAD is whether a trámite has
 * ever actually worked. `Probado` and `Propuesto` are the loudest thing on each
 * row, in that vocabulary, with the date of the proof beside it -- because the
 * consequence of confusing them is somebody scheduling a guess to run at three
 * in the morning.
 *
 * The second thing it shows without being asked is what the last run COST and
 * how long it took. That is the argument the whole module rests on, and a
 * number that only exists in a document is a number nobody believes.
 */

interface Detail {
  flow: FlowSummary & {
    steps: ProposedStep[];
    source: string;
    lastError: string | null;
    recordingFrames: number;
    extractionCostUsd: number;
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
}

export function Flows({ reloadKey }: { reloadKey: number }) {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/browser/flows');
    const payload = (await response.json()) as { flows?: FlowSummary[] };
    setFlows(payload.flows ?? []);
  }, []);

  // `reloadKey` is not read in the body on purpose: it is the parent's signal
  // that a trámite was just taught and verified, and the list has to re-fetch
  // so the new row appears with its status already resolved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the trigger, not an input
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (flows === null) {
    return (
      <Panel className="flex items-center gap-2 p-6">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-[13px] text-ink-muted">Cargando…</span>
      </Panel>
    );
  }

  if (flows.length === 0) {
    return (
      <Panel className="p-8 text-center">
        <h2 className="text-[15px] font-semibold text-ink">Todavía no hay trámites aprendidos</h2>
        <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-muted">
          Un trámite es algo que hoy alguien hace a mano en un portal: sacar un certificado,
          consultar un estado, radicar una solicitud. Se enseña una vez grabando la pestaña, y de
          ahí en adelante Cortex lo repite en segundos.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-2">
      {flows.map((flow) => (
        <Row
          key={flow.id}
          flow={flow}
          open={openId === flow.id}
          onToggle={() => setOpenId(openId === flow.id ? null : flow.id)}
          onRan={load}
        />
      ))}
    </div>
  );
}

function Row({
  flow,
  open,
  onToggle,
  onRan,
}: {
  flow: FlowSummary;
  open: boolean;
  onToggle: () => void;
  onRan: () => void;
}) {
  const tone = STATUS_TONE[flow.status];

  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-surface-2"
      >
        <ChevronRight
          className={clsx(
            'h-4 w-4 shrink-0 text-ink-faint transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-ink">{flow.name}</span>
            <span className={chipClass(tone)}>{STATUS_LABEL[flow.status]}</span>
            <span className={chipClass(flow.effect === 'write' ? 'amber' : 'neutral')}>
              {EFFECT_LABEL[flow.effect]}
            </span>
            {flow.hasCredential && (
              <span className={chipClass('neutral')}>
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                con credencial
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[12.5px] text-ink-muted">
            <span className="font-mono text-[11.5px] text-ink-faint">{flow.site}</span>
            {flow.description && ` · ${flow.description}`}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          {flow.status === 'ready' && flow.verifiedAt ? (
            <p className="text-[12px] text-ink-faint">Probado {relativeTime(flow.verifiedAt)}</p>
          ) : (
            <p className="text-[12px] text-ink-faint">Sin probar</p>
          )}
          {flow.lastRunSeconds !== null && (
            <p className="tabular mt-0.5 text-[12px] text-ink-muted">
              última: {flow.lastRunSeconds}s ·{' '}
              {flow.lastRunCostUsd ? `US$${flow.lastRunCostUsd.toFixed(4)}` : 'sin costo'}
            </p>
          )}
        </div>
      </button>

      {open && <Expanded flow={flow} onRan={onRan} />}
    </Panel>
  );
}

function Expanded({ flow, onRan }: { flow: FlowSummary; onRan: () => void }) {
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
      `${payload.message} (${payload.seconds}s, ${
        payload.modelCalls === 0
          ? 'sin llamadas al modelo'
          : `${payload.modelCalls} llamada(s) al modelo, US$${payload.costUsd.toFixed(4)}`
      })`,
    );
    setRunning(false);
    void load();
    onRan();
  }, [flow.id, inputs, load, onRan]);

  return (
    <div className="divide-y divide-border border-t border-border">
      {flow.status === 'draft' && (
        <p className="bg-amber-soft/50 px-5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
          Este trámite salió de una grabación y todavía <strong>no ha reproducido</strong>. Se puede
          correr a mano desde aquí, pero el agente no lo ve en el chat y no se puede programar hasta
          que funcione una vez completo.
          {flow.lastError && (
            <>
              {' '}
              Lo último que pasó: <span className="text-ink">{flow.lastError}</span>
            </>
          )}
        </p>
      )}
      {flow.status === 'broken' && flow.lastError && (
        <p className="bg-rose-soft/50 px-5 py-3 text-[12.5px] leading-relaxed text-rose">
          {flow.lastError}
        </p>
      )}

      <div className="p-5">
        <h3 className="field-label">Probar</h3>
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
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? 'Corriendo…' : 'Correr'}
          </Button>
        </div>
        {result && <p className="mt-3 text-[13px] leading-relaxed text-ink">{result}</p>}
      </div>

      {detail && (
        <>
          <div className="p-5">
            <h3 className="field-label">Los pasos, versión {detail.flow.version}</h3>
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
                    <span className={chipClass('amber')}>credencial</span>
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
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[12.5px]">
                  <thead>
                    <tr className="text-ink-faint">
                      <th className="pb-1.5 font-medium">Cuándo</th>
                      <th className="pb-1.5 font-medium">Cómo</th>
                      <th className="pb-1.5 font-medium">Resultado</th>
                      <th className="pb-1.5 text-right font-medium">Tiempo</th>
                      <th className="pb-1.5 text-right font-medium">Costo</th>
                    </tr>
                  </thead>
                  <tbody className="text-ink">
                    {detail.runs.map((run) => (
                      <tr key={run.id} className="border-t border-border">
                        <td className="py-1.5 text-ink-muted">{relativeTime(run.startedAt)}</td>
                        <td className="py-1.5">{MODE_LABEL[run.mode] ?? run.mode}</td>
                        <td className="py-1.5">
                          {run.status === 'succeeded' ? (
                            <span className="text-emerald">
                              {run.updatedFlow ? 'reparado y guardado' : 'listo'}
                            </span>
                          ) : (
                            <span className="text-ink-muted">
                              {FAILURE_LABEL[run.failureKind ?? ''] ?? 'falló'}
                            </span>
                          )}
                        </td>
                        <td className="tabular py-1.5 text-right">
                          {run.seconds !== null ? `${run.seconds}s` : '—'}
                        </td>
                        <td className="tabular py-1.5 text-right">
                          {run.modelCalls === 0 ? (
                            <span className="text-emerald">0</span>
                          ) : (
                            `US$${run.costUsd.toFixed(4)}`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
        </>
      )}
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
