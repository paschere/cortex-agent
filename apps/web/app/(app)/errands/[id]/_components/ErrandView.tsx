'use client';

import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  ERRAND_BOUNDARY_NOTICE,
  ERRAND_KIND_LABEL,
  type ErrandDetail,
  isErrandTerminal,
  spentFraction,
} from '@/lib/errands-shape';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  CircleStop,
  ExternalLink,
  Link2,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RunMarkdown } from '../../../schedules/_components/RunMarkdown';
import { ErrandStatusPill, stamp } from '../../_components/status';
import { AnswerBox } from './AnswerBox';

/**
 * One errand, from commission to delivery.
 *
 * ── WHAT THIS SCREEN DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * It does not draw a live console. The orchestrator already has one — SSE off
 * an append-only log, wave grouping, every tool call as it lands — and it is
 * better than anything a second implementation would be. Each leg here links
 * straight into it. What this screen owns is the layer the console cannot see:
 * why there is a second leg, what the errand asked, what it has spent, and
 * what it finally concluded.
 *
 * ── WHY IT POLLS ──────────────────────────────────────────────────────────
 *
 * An errand changes state a handful of times across forty minutes. The console
 * holds a connection open because it is watching tool calls at 2 Hz; holding
 * one open for four state changes would be expensive theatre. The poll backs
 * off the moment the errand is terminal and stops entirely — a delivered
 * errand costs nothing to look at.
 *
 * ── THE PROGRESS PROBLEM ──────────────────────────────────────────────────
 *
 * A job that takes forty minutes and says nothing feels hung, and a spinner is
 * not an answer. So the screen always states, in words, what stage the errand
 * is at, what it has spent, and what it is waiting for (describeState in
 * lib/errands/engine.ts — derived from the same rows the machine reads, so the
 * screen cannot disagree with the engine). Underneath that, the current leg
 * shows its sub-agent count live, which is the finest granularity worth having
 * here; anything finer is one click away in the console.
 */

const POLL_MS = 4_000;

export function ErrandView({ initial }: { initial: ErrandDetail }) {
  const [detail, setDetail] = useState<ErrandDetail>(initial);
  const [stopping, setStopping] = useState(false);
  const [settling, setSettling] = useState(false);

  const { errand, legs, questions, currentLeg } = detail;
  const active = !isErrandTerminal(errand.state);
  const errandId = errand.id;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/errands/${errandId}`, { cache: 'no-store' });
      if (!res.ok) return;
      setDetail((await res.json()) as ErrandDetail);
    } catch {
      // A dropped poll is not worth a broken page; the next one lands in 4s.
    }
  }, [errandId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refreshRef.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  const openQuestion = questions.find((q) => q.state === 'open') ?? null;
  const answered = questions.filter((q) => q.state === 'answered');
  const spent = Math.round(spentFraction(errand) * 100);

  async function stop() {
    if (
      !window.confirm(
        '¿Detener este encargo?\n\nNo se lanza ninguna vuelta nueva. Si hay una a medias, los subagentes que estén dentro de una herramienta terminan ese paso.',
      )
    ) {
      return;
    }
    setStopping(true);
    try {
      const res = await fetch(`/api/errands/${errandId}/cancel`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { settling?: boolean } | null;
      setSettling(Boolean(body?.settling));
      await refresh();
    } finally {
      setStopping(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href="/errands"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Encargos
        </Link>
        {active && (
          <span className="field-label inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald motion-reduce:animate-none" />
            Al día
          </span>
        )}
      </div>

      <div className="rule-double" />
      <div className="mb-5 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[20rem]">
            <div className="field-label">{ERRAND_KIND_LABEL[errand.kind]}</div>
            <h1 className="mt-1 text-[19px] font-extrabold leading-snug tracking-tight text-ink">
              {errand.request}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ErrandStatusPill state={errand.state} />
            {active ? (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopping}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-rose shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-rose-soft disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
              >
                {stopping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <CircleStop className="h-3.5 w-3.5" />
                )}
                Detener
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink motion-reduce:transform-none motion-reduce:transition-none"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Actualizar
              </button>
            )}
          </div>
        </div>

        {/* Said in words, always. A forty-minute job that only shows a spinner
            is indistinguishable from a hung one. */}
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">{detail.situation}</p>

        <Panel className="mt-3 overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <Meter label="Vueltas" value={`${errand.legsUsed} / ${errand.legCeiling}`} />
            <Meter
              label={errand.kind === 'monitor_change' ? 'Revisiones' : 'Preguntas'}
              value={String(
                errand.kind === 'monitor_change' ? errand.checksDone : questions.length,
              )}
            />
            <Meter label="Consumo" value={`${spent}%`} />
            <Meter label="Tokens" value={errand.tokensSpent.toLocaleString('es-CO')} />
          </div>
        </Panel>

        {/* The ceiling, drawn. Amber past 80% — attention, not alarm: the
            errand is fine, it is simply going to stop soon. */}
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={clsx(
                'h-full rounded-full transition-[width] duration-500',
                spent >= 80 ? 'bg-amber' : 'bg-primary',
              )}
              style={{ width: `${Math.max(2, spent)}%` }}
            />
          </div>
          <p className="tabular mt-1 text-[11px] text-ink-faint">
            Tope de consumo: {errand.tokenCeiling.toLocaleString('es-CO')} tokens. Al llegar ahí se
            cierra con lo que tenga.
          </p>
        </div>
      </div>

      {settling && (
        <Panel className="mb-5 border-border-strong bg-surface-2 px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-muted">
            <CircleStop className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
            <span className="min-w-0">
              Pedimos detenerlo. No se lanza nada nuevo, pero la vuelta que iba a medias termina el
              paso en el que está: una llamada ya enviada no se puede devolver.
            </span>
          </p>
        </Panel>
      )}

      {/* ── THE QUESTION ──────────────────────────────────────────────────
          Above everything else, including the deliverable, because it is the
          only thing on this page that is waiting on the person reading it. */}
      {openQuestion && (
        <Panel className="mb-5 border-amber/40 bg-amber-soft overflow-hidden">
          <div className="px-4 py-3">
            <div className="flex items-start gap-2">
              <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
              <div className="min-w-0">
                <h2 className="text-[14.5px] font-bold text-amber">{openQuestion.question}</h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                  {openQuestion.why}
                </p>
              </div>
            </div>
            <AnswerBox
              errandId={errand.id}
              questionId={openQuestion.id}
              options={openQuestion.options}
              onAnswered={() => void refresh()}
            />
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Nada se pierde mientras esperas: lo que ya encontró está guardado y sigue desde ahí
              apenas contestes.
            </p>
          </div>
        </Panel>
      )}

      {/* ── THE DELIVERABLE ───────────────────────────────────────────────── */}
      <Panel className="mb-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="field-label">Resultado</div>
          {errand.deliverable && errand.finishedAt && (
            <Provenance
              source="Encargo"
              readAt={stamp(errand.finishedAt)}
              detail={`${errand.legsUsed} ${errand.legsUsed === 1 ? 'vuelta' : 'vueltas'}`}
              tone={errand.state === 'failed' ? 'seal' : 'stamp'}
            />
          )}
        </div>
        <div className="rule-double" />
        <div className="px-4 py-4">
          {errand.deliverable ? (
            <RunMarkdown>{errand.deliverable}</RunMarkdown>
          ) : active ? (
            <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Todavía no hay resultado. Cortex lo escribe cuando tenga con qué.
            </p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">
              Este encargo no alcanzó a producir un resultado. Abajo está hasta dónde llegó.
            </p>
          )}

          {errand.closingNote && (
            <p className="mt-4 border-t border-border pt-3 text-[12.5px] leading-relaxed text-ink-muted">
              {errand.closingNote}
            </p>
          )}
        </div>

        {/* ── THE SOURCE LEDGER ───────────────────────────────────────────
            The product's whole claim is that nothing it says is unattributed,
            so a research result without provenance would be a rumour with a
            table around it. Every entry that was actually FETCHED carries the
            instant it was read, harvested from the run's own tool calls rather
            than from the model's account of itself — see
            lib/errands/repository.ts `harvestSources`. */}
        {errand.sources.length > 0 && (
          <>
            <div className="rule-double" />
            <div className="px-4 py-3">
              <div className="field-label mb-2">Fuentes ({errand.sources.length})</div>
              <ol className="flex flex-col gap-1.5">
                {errand.sources.map((source, i) => (
                  <li
                    key={`${source.url ?? source.title}-${i}`}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]"
                  >
                    <span className="tabular shrink-0 text-ink-faint">[{i + 1}]</span>
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-primary hover:underline"
                      >
                        <Link2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">{source.title}</span>
                      </a>
                    ) : (
                      <span className="min-w-0 truncate font-medium text-ink">{source.title}</span>
                    )}
                    <Provenance
                      source={source.url ? 'Web' : 'Cortex'}
                      readAt={stamp(source.readAt)}
                    />
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </Panel>

      {/* ── THE LEGS ───────────────────────────────────────────────────────
          Each one links into the orchestrator's live console rather than
          reimplementing it. */}
      {legs.length > 0 && (
        <Panel className="mb-5 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="field-label">Vueltas</div>
            <div className="tabular text-[11px] text-ink-faint">
              {legs.length} de {errand.legCeiling} permitidas
            </div>
          </div>
          <div className="rule-double" />
          <ul>
            {legs.map((leg) => {
              const isCurrent = currentLeg?.runId === leg.runId && leg.status === 'running';
              return (
                <li key={leg.id} className="border-b border-border px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="tabular text-[11px] font-bold text-ink-faint">
                        Vuelta {leg.seq}
                      </span>
                      <span
                        className={clsx(
                          'text-[12px] font-semibold',
                          leg.status === 'completed' && 'text-emerald',
                          leg.status === 'running' && 'text-primary',
                          (leg.status === 'failed' ||
                            leg.status === 'interrupted' ||
                            leg.status === 'cancelled') &&
                            'text-rose',
                        )}
                      >
                        {LEG_LABEL[leg.status]}
                      </span>
                      {isCurrent && currentLeg && currentLeg.total > 0 && (
                        <span className="tabular text-[11px] text-ink-muted">
                          {currentLeg.done}/{currentLeg.total} subagentes
                          {currentLeg.working.length > 0 && ` · ${currentLeg.working[0]}`}
                        </span>
                      )}
                      {leg.tokens > 0 && (
                        <span className="tabular text-[11px] text-ink-faint">
                          {leg.tokens.toLocaleString('es-CO')} tokens
                        </span>
                      )}
                    </div>
                    {leg.runId && (
                      <Link
                        href={`/orchestrator/${leg.runId}`}
                        className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
                      >
                        Ver en vivo <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {/* Answered questions, kept visible: they are part of how the result was
          arrived at, and a reader deciding whether to trust it should see what
          the errand was told. */}
      {answered.length > 0 && (
        <Panel className="mb-5 overflow-hidden">
          <div className="px-4 py-3">
            <div className="field-label">Lo que le aclaraste</div>
          </div>
          <div className="rule-double" />
          <ul>
            {answered.map((q) => (
              <li key={q.id} className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="text-[12.5px] font-semibold text-ink">{q.question}</div>
                <div className="mt-1 text-[12.5px] text-ink-muted">→ {q.answer}</div>
                {q.answeredAt && (
                  <div className="tabular mt-1 text-[11px] text-ink-faint">
                    {stamp(q.answeredAt)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <p className="flex items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span>{ERRAND_BOUNDARY_NOTICE}</span>
      </p>
    </>
  );
}

const LEG_LABEL: Record<string, string> = {
  running: 'Trabajando',
  completed: 'Terminó',
  failed: 'Falló',
  interrupted: 'Se interrumpió',
  cancelled: 'Detenida',
};

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="field-label">{label}</div>
      <div className="stat-num mt-0.5 truncate text-[16px] leading-none text-ink">{value}</div>
    </div>
  );
}
