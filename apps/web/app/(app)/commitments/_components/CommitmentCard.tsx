'use client';

import { Provenance } from '@/components/ui/provenance';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  BellRing,
  CalendarOff,
  Car,
  Check,
  Eye,
  Loader2,
  RefreshCw,
  Repeat,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { cop, longDate, whenPhrase } from './format';
import type { CommitmentView } from './types';

/**
 * One commitment, as a card.
 *
 * THE PROVENANCE CHIP IS NOT DECORATION HERE. Every card asserts a date the
 * person did not put in front of themselves, so every card carries where it
 * came from — RUNT and when it was read, the document and the sentence, or the
 * colleague who wrote it down. Without it the screen is a list of numbers with
 * no way to tell which ones to trust, which is exactly the state this module
 * replaced.
 *
 * The colour is the design system's, meaning what it already means: emerald in
 * force, amber lapsing, rose lapsed. Nothing else on the card is coloured, so
 * the one that is reads instantly from across a desk.
 */

const STATE_TONE: Record<CommitmentView['state'], StatusTone> = {
  in_force: 'emerald',
  due_soon: 'amber',
  overdue: 'rose',
  met: 'neutral',
  dropped: 'neutral',
};

export function CommitmentCard({
  commitment: c,
  busy,
  onFulfil,
  onAcknowledge,
}: {
  commitment: CommitmentView;
  busy: boolean;
  onFulfil: () => void;
  onAcknowledge: () => void;
}) {
  const tone = STATE_TONE[c.state];
  const overdue = c.state === 'overdue';
  const closed = c.state === 'met' || c.state === 'dropped';

  return (
    <article
      className={clsx(
        'rounded-card border bg-surface p-4 shadow-card transition-shadow duration-150',
        'motion-reduce:transition-none',
        // A lapsed commitment gets a warmer edge, not a red box: the chip and
        // the days figure already say it, and a red panel makes the next one
        // unreadable.
        overdue ? 'border-rose/25' : 'border-border',
        closed && 'opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={chipClass(tone)}>{c.stateLabel}</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
              {c.kindLabel}
            </span>
            {c.recurrence !== 'none' && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-ink-faint"
                title="Se repite"
              >
                <Repeat className="h-3 w-3" aria-hidden />
                {c.recurrence === 'from_source' ? 'la trae el sistema' : 'se repite'}
              </span>
            )}
          </div>
          <h3 className="mt-1.5 truncate text-[15px] font-semibold text-ink">
            <Link
              href={`/commitments/${c.id}`}
              className="rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {c.title}
            </Link>
          </h3>
          {(c.counterparty || c.vehiclePlate) && (
            <p className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-muted">
              {c.vehiclePlate && (
                <span className="inline-flex items-center gap-1">
                  <Car className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  <span className="tabular">{c.vehiclePlate}</span>
                </span>
              )}
              {c.counterparty && <span className="truncate">{c.counterparty}</span>}
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">
          <div
            className={clsx(
              'tabular text-[15px] font-semibold leading-none',
              overdue ? 'text-rose' : c.state === 'due_soon' ? 'text-amber' : 'text-ink',
            )}
          >
            {c.dueLabel}
          </div>
          <div
            className={clsx(
              'mt-1 text-[11.5px]',
              overdue ? 'font-semibold text-rose' : 'text-ink-faint',
            )}
          >
            {whenPhrase(c.daysLeft)}
          </div>
        </div>
      </div>

      {c.amountCop != null && (
        <div className="mt-3">
          <div className="field-label">Valor</div>
          <div className="stat-num text-[17px] leading-none text-ink">{cop(c.amountCop)}</div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Provenance
          source={c.source.label}
          readAt={c.source.readAt ?? undefined}
          detail={sourceDetail(c)}
          tone={overdue ? 'seal' : 'stamp'}
        />
        {c.noticesSent > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-ink-faint"
            title={c.lastNoticeOn ? `Último aviso: ${longDate(c.lastNoticeOn)}` : undefined}
          >
            <BellRing className="h-3 w-3" aria-hidden />
            <span className="tabular">{c.noticesSent}</span> avisado
          </span>
        )}
        {c.acknowledged && (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
            <Eye className="h-3 w-3" aria-hidden /> visto
          </span>
        )}
        {c.calendarError && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-ink-faint"
            title={c.calendarError}
          >
            <CalendarOff className="h-3 w-3" aria-hidden /> sin calendario
          </span>
        )}
      </div>

      {!closed && (
        <div className="mt-3.5 flex items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onFulfil}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:border-emerald/40 hover:text-emerald disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transform-none motion-reduce:transition-none"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Cumplido
          </button>
          {overdue && !c.acknowledged && (
            <button
              type="button"
              onClick={onAcknowledge}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              title="Frena el escalamiento sin decir que ya está resuelto"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden />
              Ya lo vi
            </button>
          )}
          <Link
            href={`/commitments/${c.id}`}
            className="ml-auto text-[12.5px] font-medium text-ink-faint transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            Ver detalle
          </Link>
        </div>
      )}
    </article>
  );
}

/** The qualifier on the chip: short, and only when it adds something. */
function sourceDetail(c: CommitmentView): string | undefined {
  if (!c.source.confirmed) return 'sin confirmar';
  if (c.source.kind === 'document') return 'cita en el detalle';
  if (c.source.kind === 'manual') return 'a mano';
  return undefined;
}

/**
 * A proposal in the review queue: the extracted date next to the sentence it
 * was read from, so the decision is a comparison rather than an act of faith.
 */
export function ProposalCard({
  commitment: c,
  busy,
  onConfirm,
  onReject,
}: {
  commitment: CommitmentView;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <article className="rounded-card border border-amber/25 bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={chipClass('amber')}>Sin confirmar</span>
          <h3 className="mt-1.5 truncate text-[15px] font-semibold text-ink">{c.title}</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {c.kindLabel}
            {c.counterparty ? ` · ${c.counterparty}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular text-[15px] font-semibold leading-none text-ink">
            {c.dueLabel}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-faint">{whenPhrase(c.daysLeft)}</div>
        </div>
      </div>

      {c.source.quote && (
        <blockquote className="mt-3 rounded-sm border-l-2 border-amber/40 bg-amber-soft/40 px-3 py-2">
          <div className="field-label">Lo que dice el documento</div>
          <p className="mt-1 font-mono text-[12.5px] leading-relaxed text-ink">
            «{c.source.quote}»
          </p>
        </blockquote>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Provenance source={c.source.label} readAt={c.source.readAt ?? undefined} />
        <span className="text-[11.5px] text-ink-faint">
          No se está vigilando: no manda avisos hasta que alguien la confirme.
        </span>
      </div>

      <div className="mt-3.5 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transform-none motion-reduce:transition-none"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden />
          )}
          Confirmar y vigilar
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-rose-soft hover:text-rose disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 motion-reduce:transition-none"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Descartar
        </button>
        {c.source.documentId && (
          <Link
            href={`/kb?document=${c.source.documentId}`}
            className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-faint transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Abrir el documento
          </Link>
        )}
      </div>
    </article>
  );
}
