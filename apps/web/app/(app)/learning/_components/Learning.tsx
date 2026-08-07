'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  FileWarning,
  Lightbulb,
  RotateCcw,
  Sprout,
  Undo2,
  X,
} from 'lucide-react';
import { type ReactNode, useState, useTransition } from 'react';
import { decideProposal, refreshLearning, undoAdjustment } from '../actions';
import type { AdjustmentCard, LearningView, ProposalCard, SignalCard } from './types';

/**
 * The page, in three sections, in the order somebody actually needs them.
 *
 *   QUÉ CAMBIÓ SOLO   what is in force right now, each with an undo button
 *   QUÉ HAY QUE DECIDIR   what Cortex worked out but is not allowed to act on
 *   DE DÓNDE SALIÓ    the raw observations, so nothing above is unaccountable
 *
 * WHAT WAS LEFT OUT. No score, no "learning health", no trend line. Every one
 * of those would be a number invented to look like progress on a page whose
 * only claim is that each figure is a count of rows somebody can go and read.
 * The one thing that looks like a metric — "antes / desde" on each adjustment —
 * is deliberately not framed as an improvement: it is what has been observed
 * before and after, and if the after is worse the page says so plainly.
 */
export function Learning({ view }: { view: LearningView }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-card border border-rose/30 bg-rose-soft px-4 py-3 text-[12.5px] text-rose">
          {error}
        </div>
      )}

      <Explainer onRefresh={() => run(refreshLearning)} busy={pending} />

      {view.quiet ? (
        <Quiet />
      ) : (
        <>
          <Section
            title="Qué cambió solo"
            hint="Ajustes que Cortex se aplicó a sí mismo. Todos son de orden: cambian cuál se cita primero entre los fragmentos que ya pasaron el umbral de relevancia. Ninguno cambia lo que la empresa da por cierto."
          >
            {view.active.length === 0 ? (
              <Empty>Nada aplicado por ahora. Hace falta más evidencia.</Empty>
            ) : (
              <div className="space-y-3">
                {view.active.map((a) => (
                  <Adjustment
                    key={a.id}
                    card={a}
                    busy={pending}
                    onUndo={() => run(() => undoAdjustment(a.id))}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Qué hay que decidir"
            hint="Cosas que Cortex notó y que NO se aplica solo, porque cambiarían lo que el sistema cree que es verdad. Aquí solo se te avisan, con la evidencia al lado."
          >
            {view.proposals.length === 0 ? (
              <Empty>No hay nada esperando decisión.</Empty>
            ) : (
              <div className="space-y-3">
                {view.proposals.map((p) => (
                  <Proposal
                    key={p.id}
                    card={p}
                    busy={pending}
                    onDecide={(d) => run(() => decideProposal(p.id, d))}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="De dónde salió"
            hint="Las señales que se recogieron, tal cual. Nadie calificó ninguna respuesta: todo esto es rastro de gente trabajando."
          >
            {view.signals.length === 0 ? (
              <Empty>Todavía no se ha observado nada.</Empty>
            ) : (
              <Panel className="divide-y divide-border">
                {view.signals.map((s) => (
                  <Signal key={s.id} card={s} />
                ))}
              </Panel>
            )}
          </Section>

          {(view.past.length > 0 || view.decided.length > 0) && (
            <Section
              title="Lo que ya no está"
              hint="Ajustes deshechos o vencidos, y propuestas que alguien ya decidió. Se guardan: un ajuste que se deshizo dice más que uno que nunca se hizo."
            >
              <Panel className="divide-y divide-border">
                {view.past.map((a) => (
                  <PastRow
                    key={a.id}
                    left={`${a.label} · ${docName(a)}`}
                    right={a.revokedReason ?? (a.status === 'expired' ? 'Venció' : 'Deshecho')}
                    when={a.revokedAt}
                  />
                ))}
                {view.decided.map((p) => (
                  <PastRow key={p.id} left={p.headline} right={p.statusLabel} when={p.decidedAt} />
                ))}
              </Panel>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

/**
 * The rule, said once, at the top.
 *
 * It is on the page and not only in the code because the reason this is safe to
 * leave running is a rule about what it may do, and a rule nobody reads is a
 * rule nobody can hold it to.
 */
function Explainer({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h2 className="flex items-center gap-2 text-[14px] font-bold text-ink">
            <Sprout className="h-4 w-4 text-emerald" />
            Cómo aprende, y hasta dónde puede llegar solo
          </h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
            Cortex mira cómo se usa: si alguien vuelve a preguntar lo mismo con otras palabras al
            minuto, si copia un fragmento, si corrige a mano una fecha o un dato que se leyó de un
            documento. Con eso ordena mejor lo que ya sirve.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
            <span className="font-semibold text-ink">Lo que sí hace solo:</span> mover un fragmento
            adelante o atrás <em>dentro de su mismo grupo de relevancia</em>. Nunca sube uno que no
            alcanzó el umbral, nunca tumba el único que sí sirve, y nunca cambia una palabra de un
            documento. <span className="font-semibold text-ink">Lo que no hace solo:</span> nada que
            cambie lo que la empresa da por cierto. Eso queda abajo, esperando a una persona.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
            Todo ajuste vence a los 90 días si deja de haber evidencia, y cualquiera lo puede
            deshacer de un clic.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-2 rounded-pill border border-border bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-card transition hover:bg-surface-2 disabled:opacity-50"
        >
          <RotateCcw className={clsx('h-3.5 w-3.5', busy && 'animate-spin')} />
          {busy ? 'Revisando…' : 'Revisar ahora'}
        </button>
      </div>
    </Panel>
  );
}

function Quiet() {
  return (
    <Panel className="p-8 text-center">
      <p className="text-[13px] font-semibold text-ink">Todavía no ha aprendido nada.</p>
      <p className="mx-auto mt-2 max-w-lg text-[12.5px] leading-relaxed text-ink-muted">
        Necesita que la gente use el chat y revise vencimientos y documentos. En cuanto haya
        conversaciones en las que alguien repita una pregunta, o corrija a mano un dato que Cortex
        leyó, esto se empieza a llenar solo. No hay nada que configurar.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------- adjustments */

function docName(a: { document: { title: string | null; withheld: boolean } }): string {
  if (a.document.withheld) return 'Un documento de un espacio que no puedes ver';
  return a.document.title ?? 'Un documento que ya no está';
}

function Adjustment({
  card,
  busy,
  onUndo,
}: {
  card: AdjustmentCard;
  busy: boolean;
  onUndo: () => void;
}) {
  const negative = card.kind !== 'prefer_fragment';
  // What has been observed since it went in, next to what was observed before.
  // Not framed as an improvement: it is a count, and a count that got worse is
  // the most useful thing this page can tell anybody.
  const worseSince = card.since.negative > card.since.positive && card.since.negative > 0;

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[11.5px] font-bold',
                negative ? 'bg-amber-soft text-amber' : 'bg-emerald-soft text-emerald',
              )}
            >
              {negative ? (
                <ArrowDownToLine className="h-3 w-3" />
              ) : (
                <ArrowUpToLine className="h-3 w-3" />
              )}
              {card.label}
            </span>
            <span className="text-[12.5px] text-ink-faint">
              vence en {card.daysLeft} {card.daysLeft === 1 ? 'día' : 'días'}
            </span>
          </div>
          <p className="mt-2 truncate text-[13.5px] font-semibold text-ink">
            {docName(card)}
            {card.chunkIndex >= 0 && (
              <span className="ml-1.5 font-normal text-ink-faint">
                · fragmento {card.chunkIndex}
              </span>
            )}
          </p>
          {card.document.spaceName && (
            <p className="mt-0.5 text-[11.5px] text-ink-faint">en {card.document.spaceName}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Deshacer
        </button>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">{card.explanation}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Box title="Con qué evidencia se aplicó">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {card.evidence.actors === 1
              ? 'Una sola persona, pero en '
              : `${card.evidence.actors} personas distintas, en `}
            {card.evidence.days} {card.evidence.days === 1 ? 'día' : 'días'} distintos.{' '}
            {card.evidence.negative > 0 && `${card.evidence.negative} en contra`}
            {card.evidence.negative > 0 && card.evidence.positive > 0 && ', '}
            {card.evidence.positive > 0 && `${card.evidence.positive} a favor`}.
          </p>
        </Box>
        <Box title="Qué se ha visto desde entonces">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {card.since.negative === 0 && card.since.positive === 0
              ? 'Nada nuevo todavía. Si no vuelve a aparecer evidencia, este ajuste se vence solo.'
              : `${card.since.negative} en contra y ${card.since.positive} a favor (antes: ${card.before.negative} y ${card.before.positive}).`}
          </p>
          {worseSince && (
            <p className="mt-1.5 text-[11.5px] font-semibold text-amber">
              Sigue apareciendo evidencia en contra: el ajuste no está resolviendo el problema.
            </p>
          )}
        </Box>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- proposals */

const PROPOSAL_ICON: Record<ProposalCard['kind'], ReactNode> = {
  contradicted_value: <FileWarning className="h-4 w-4" />,
  badly_cut_fragment: <FileWarning className="h-4 w-4" />,
  unanswered_question: <Lightbulb className="h-4 w-4" />,
};

function Proposal({
  card,
  busy,
  onDecide,
}: {
  card: ProposalCard;
  busy: boolean;
  onDecide: (decision: 'accepted' | 'dismissed') => void;
}) {
  return (
    <Panel>
      <PanelHead icon={PROPOSAL_ICON[card.kind]} title={card.label} />
      <div className="px-5 pb-5 pt-2">
        <p className="text-[13.5px] font-semibold text-ink">{card.headline}</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{card.detail}</p>
        {card.document && (
          <p className="mt-2 text-[11.5px] text-ink-faint">
            {card.document.withheld
              ? 'En un documento de un espacio que no puedes ver.'
              : `En «${card.document.title ?? 'un documento que ya no está'}»`}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onDecide('accepted')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Me hago cargo
          </button>
          <button
            type="button"
            onClick={() => onDecide('dismissed')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            No es un problema
          </button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-ink-faint">
          Cualquiera de las dos es solo una nota. Cortex no toca el documento en ningún caso.
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ signals */

function Signal({ card }: { card: SignalCard }) {
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <span
        className={clsx(
          'mt-1 h-2 w-2 shrink-0 rounded-full',
          card.polarity === 1 ? 'bg-emerald' : 'bg-amber',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-ink">{card.note}</p>
        {card.asked && (
          <p className="mt-0.5 truncate text-[11.5px] text-ink-faint">«{card.asked}»</p>
        )}
        <p className="mt-0.5 text-[11.5px] text-ink-faint">
          {docName(card)}
          {card.chunkIndex >= 0 && ` · fragmento ${card.chunkIndex}`}
        </p>
      </div>
      <span className="shrink-0 text-[11.5px] text-ink-faint">{when(card.observedAt)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- bits */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5">
        <h2 className="text-[14px] font-bold text-ink">{title}</h2>
        <p className="mt-0.5 max-w-3xl text-[12px] leading-relaxed text-ink-faint">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card bg-surface-2 px-4 py-3">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{title}</p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <Panel className="px-5 py-6 text-center text-[12.5px] text-ink-muted">{children}</Panel>;
}

function PastRow({
  left,
  right,
  when: at,
}: {
  left: string;
  right: string;
  when: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-3">
      <p className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{left}</p>
      <p className="shrink-0 text-[11.5px] text-ink-faint">
        {right}
        {at && ` · ${when(at)}`}
      </p>
    </div>
  );
}

/** "hace 3 h", "12 mar 2026". Local to this page; nothing else needs it. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 60) return `hace ${Math.max(1, minutes)} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
