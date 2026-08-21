'use client';

import {
  Brain,
  BrainCircuit,
  CheckCircle2,
  CircleHelp,
  ListChecks,
  Loader2,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';

/**
 * LA LECTURA DE CORTEX DE UNA LLAMADA, Y SI QUEDA EN EL BRAIN.
 *
 * Cuando el bot cuelga, Cortex lee el transcript una vez y deja esto: de qué
 * fue, qué se decidió, quién se comprometió a qué, qué sigue, y un veredicto
 * —con su razón— sobre si la llamada merece quedar en Brain Knowledge. El
 * veredicto es suyo por defecto; la barra de arriba deja que una persona le
 * dé la vuelta con un clic, y dice quién decidió para que nadie se pregunte
 * por qué una llamada está o no está en la memoria de la empresa.
 */

export interface Insights {
  title: string;
  summary: string;
  highlights: string[];
  decisions: string[];
  commitments: { who: string; what: string; when: string | null }[];
  nextSteps: string[];
  openQuestions: string[];
  worthKeeping: boolean;
  reason: string;
}

export type BrainStatus = 'pending' | 'kept' | 'skipped';

export function BrainBadge({
  status,
  compact = false,
}: { status: BrainStatus; compact?: boolean }) {
  const look =
    status === 'kept'
      ? { cls: 'bg-primary-soft text-primary', Icon: Brain, label: 'En el Brain' }
      : status === 'skipped'
        ? { cls: 'bg-surface-2 text-ink-faint', Icon: Brain, label: 'Fuera del Brain' }
        : { cls: 'bg-amber-soft text-amber', Icon: Loader2, label: 'Por decidir' };
  const { Icon } = look;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] font-medium ${look.cls}`}
      title={look.label}
    >
      <Icon className={`h-3 w-3 ${status === 'pending' ? 'animate-spin' : ''}`} />
      {compact ? null : look.label}
    </span>
  );
}

export function BrainDecision({
  callId,
  status,
  reason,
  decidedBy,
  onChange,
}: {
  callId: string;
  status: BrainStatus;
  reason: string | null;
  decidedBy: 'cortex' | 'person' | null;
  onChange: (next: BrainStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'keep' | 'drop') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/archive/${encodeURIComponent(callId)}/brain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        brainStatus?: BrainStatus;
        error?: string;
      };
      if (!res.ok || !data.brainStatus) throw new Error(data.error ?? 'No se pudo cambiar.');
      onChange(data.brainStatus);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const who =
    decidedBy === 'person'
      ? 'Lo decidió una persona'
      : decidedBy === 'cortex'
        ? 'Lo decidió Cortex'
        : null;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border px-3.5 py-2.5 text-sm ${
        status === 'kept'
          ? 'border-primary/30 bg-primary-soft/40'
          : status === 'skipped'
            ? 'border-border bg-surface-2'
            : 'border-amber/30 bg-amber-soft/40'
      }`}
    >
      <BrainCircuit
        className={`h-4 w-4 shrink-0 ${status === 'kept' ? 'text-primary' : status === 'pending' ? 'text-amber' : 'text-ink-faint'}`}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">
          {status === 'kept'
            ? 'Guardada en Brain Knowledge'
            : status === 'skipped'
              ? 'Fuera de Brain Knowledge'
              : 'Cortex todavía no decidió si va al Brain'}
          {who ? <span className="font-normal text-ink-faint"> · {who}</span> : null}
        </p>
        {reason ? <p className="text-xs text-ink-muted">{reason}</p> : null}
        {error ? <p className="text-xs text-rose">{error}</p> : null}
      </div>
      <div className="flex items-center gap-1.5">
        {status !== 'kept' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('keep')}
            className="inline-flex items-center gap-1 rounded-pill bg-primary px-3 py-1.5 text-xs font-medium text-primary-ink disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Brain className="h-3.5 w-3.5" />
            )}
            Guardar en el Brain
          </button>
        ) : null}
        {status !== 'skipped' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('drop')}
            className="inline-flex items-center gap-1 rounded-pill border border-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {status === 'kept' ? 'Sacar del Brain' : 'No guardar'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {icon} {title}
      </h4>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm text-ink">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
          <span className="min-w-0">{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function CallInsights({
  insights,
  analyzing,
}: { insights: Insights | null; analyzing: boolean }) {
  if (!insights) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-dashed border-border px-3.5 py-3 text-sm text-ink-muted">
        {analyzing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Cortex está leyendo la
            llamada…
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4 text-ink-faint" /> Cortex no alcanzó a analizar esta
            llamada.
          </>
        )}
      </div>
    );
  }
  if (!insights.summary) {
    return (
      <div className="rounded-card border border-border bg-surface-2 px-3.5 py-3 text-sm text-ink-muted">
        {insights.reason || 'Casi no se habló en esta llamada.'}
      </div>
    );
  }

  const hasLists =
    insights.decisions.length +
      insights.commitments.length +
      insights.nextSteps.length +
      insights.openQuestions.length +
      insights.highlights.length >
    0;

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card">
      <div>
        <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Sparkles className="h-3.5 w-3.5" /> Lo que sacó Cortex
        </h3>
        <p className="text-sm leading-relaxed text-ink">{insights.summary}</p>
      </div>

      {hasLists ? (
        <div className="grid gap-4 md:grid-cols-2">
          {insights.decisions.length ? (
            <Section
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald" />}
              title="Decisiones"
            >
              <Bullets items={insights.decisions} />
            </Section>
          ) : null}
          {insights.commitments.length ? (
            <Section icon={<UserCheck className="h-3.5 w-3.5 text-primary" />} title="Compromisos">
              <ul className="flex flex-col gap-1.5 text-sm">
                {insights.commitments.map((c) => (
                  <li key={`${c.who}-${c.what}`} className="flex flex-col">
                    <span className="text-ink">
                      <span className="font-semibold">{c.who}</span> — {c.what}
                    </span>
                    {c.when ? <span className="text-xs text-ink-muted">para {c.when}</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {insights.nextSteps.length ? (
            <Section icon={<ListChecks className="h-3.5 w-3.5 text-sky" />} title="Próximos pasos">
              <Bullets items={insights.nextSteps} />
            </Section>
          ) : null}
          {insights.openQuestions.length ? (
            <Section icon={<CircleHelp className="h-3.5 w-3.5 text-amber" />} title="Quedó abierto">
              <Bullets items={insights.openQuestions} />
            </Section>
          ) : null}
          {insights.highlights.length && !insights.decisions.length ? (
            <Section
              icon={<Sparkles className="h-3.5 w-3.5 text-ink-faint" />}
              title="Lo más importante"
            >
              <Bullets items={insights.highlights} />
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
