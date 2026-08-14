'use client';

import { relativeTime } from '@/lib/relative-time';
import { CHIP_TONE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  MapPin,
  Quote,
  ShieldCheck,
  UserRound,
  UserSearch,
} from 'lucide-react';
import { STATUS_META } from './status';
import type { Prospect, SignalStatus } from './types';

interface Action {
  next: SignalStatus;
  label: string;
  /** One filled button per card at most — the obvious next move. */
  primary?: boolean;
}

/**
 * What can be done from each stage. Every route between the four states is
 * reachable in one or two clicks, including backwards: a mis-click on Reject
 * has to be undoable or nobody will use the buttons with any confidence.
 */
const ACTIONS: Record<SignalStatus, Action[]> = {
  new: [
    { next: 'qualified', label: 'Calificar', primary: true },
    { next: 'rejected', label: 'Descartar' },
  ],
  qualified: [
    { next: 'contacted', label: 'Marcar como contactado', primary: true },
    { next: 'rejected', label: 'Descartar' },
  ],
  contacted: [
    { next: 'qualified', label: 'Volver a calificados' },
    { next: 'rejected', label: 'Descartar' },
  ],
  rejected: [
    { next: 'new', label: 'Devolver a nuevos' },
    { next: 'qualified', label: 'Calificar de todas formas' },
  ],
};

export function ProspectCard({
  prospect,
  busyWith,
  error,
  filedAway,
  onMove,
}: {
  prospect: Prospect;
  busyWith: SignalStatus | null;
  error: string | null;
  /** True when the row only survives the current filter because it just moved. */
  filedAway: boolean;
  onMove: (next: SignalStatus) => void;
}) {
  const meta = STATUS_META[prospect.status];
  const Icon = meta.icon;
  const moving = busyWith !== null;

  return (
    // The one card on this board a person actually picks up: an action moves
    // it to another column, so the card lifts and glows indigo while that move
    // is in flight, and settles back once the new stage is confirmed.
    <div
      className={clsx(
        'rounded-card border bg-surface p-4 shadow-card transition-all duration-200',
        'motion-reduce:transition-none motion-reduce:transform-none',
        moving
          ? '-translate-y-0.5 border-primary/30 shadow-pop ring-2 ring-primary/20'
          : 'border-border hover:-translate-y-px hover:shadow-pop',
      )}
    >
      {/* ------------------------------------------------------------ header */}
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            'grid h-9 w-9 shrink-0 place-items-center rounded-sm border',
            CHIP_TONE[meta.tone],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base font-bold text-ink">{prospect.company}</span>
            <span className={chipClass(meta.tone)}>{meta.label}</span>
          </div>
          <div className="mt-0.5 text-sm text-ink-muted">
            busca <span className="font-semibold text-ink">{prospect.roleTitle}</span>
          </div>

          <div className="tabular mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
            <a
              href={prospect.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-primary hover:text-primary-strong"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {prospect.source}
            </a>
            {prospect.region && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {prospect.region}
              </span>
            )}
            <span>encontrado {relativeTime(prospect.createdAt)}</span>
            {prospect.reviewedAt && prospect.status !== 'new' && (
              <span>
                {meta.done}
                {prospect.reviewerName ? ` por ${prospect.reviewerName}` : ''}{' '}
                {relativeTime(prospect.reviewedAt)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Answers "did it disappear?" in the place the question gets asked. */}
      {filedAway && (
        <p className="mt-3 rounded-sm border border-border bg-surface-2 px-3 py-2 text-micro text-ink-muted">
          Quedó archivado en <b className="text-ink">{meta.label}</b>. Sigue aquí, y lo vas a
          encontrar en esa pestaña la próxima vez.
        </p>
      )}

      {/* ---------------------------------------------------------- evidence */}
      {prospect.summary && (
        <div className="mt-3 rounded-sm border border-border bg-surface-2 px-3 py-2.5">
          <div className="field-label mb-1 flex items-center gap-1.5">
            <Quote className="h-3 w-3" />
            Por qué parece un buen prospecto
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">{prospect.summary}</p>
        </div>
      )}

      {/* ----------------------------------------------------------- contact */}
      <Contact prospect={prospect} />

      {error && (
        <p className="mt-3 rounded-sm border border-rose/40 bg-rose-soft px-3 py-2 text-xs text-rose">
          {error} El prospecto volvió a su estado anterior.
        </p>
      )}

      {/* ----------------------------------------------------------- actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {ACTIONS[prospect.status].map((action) => {
          const running = busyWith === action.next;
          const disabled = busyWith !== null;
          return (
            <button
              key={action.next}
              type="button"
              disabled={disabled}
              onClick={() => onMove(action.next)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-xs font-semibold transition-all duration-150',
                'hover:-translate-y-px disabled:opacity-60 disabled:hover:translate-y-0',
                'motion-reduce:transform-none motion-reduce:transition-none',
                action.primary
                  ? 'bg-primary text-white hover:bg-primary-strong'
                  : 'border border-border-strong text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {running && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The contact, with its confidence stated in words rather than a colour nobody
 * decodes. An INFERRED address is a guess built from a pattern — it is never
 * rendered as a mailto link, because a link is a promise that it works.
 */
function Contact({ prospect }: { prospect: Prospect }) {
  const { contactName, contactTitle, contactPath, contactConfidence } = prospect;

  if (!contactName && !contactPath) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
        <UserSearch className="h-3.5 w-3.5" />
        Sin contacto todavía. Pídele a Cortex en el chat que averigüe quién contrata este perfil.
      </p>
    );
  }

  const verified = contactConfidence === 'found';
  const guessed = contactConfidence === 'inferred';
  const isEmail = !!contactPath?.includes('@');

  return (
    <div className="mt-3 rounded-sm border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <UserRound className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-xs font-semibold text-ink">{contactName ?? 'Contacto'}</span>
        {contactTitle && <span className="text-xs text-ink-muted">· {contactTitle}</span>}
        <span
          className={clsx(
            'ml-auto',
            chipClass(verified ? 'emerald' : guessed ? 'amber' : 'neutral'),
          )}
        >
          {verified ? (
            <ShieldCheck className="h-3 w-3" />
          ) : guessed ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          {verified ? 'visto en público' : guessed ? 'sin verificar' : 'sin confirmar'}
        </span>
      </div>

      {contactPath &&
        (verified && isEmail ? (
          <a
            href={`mailto:${contactPath}`}
            className="mt-1.5 inline-block text-xs font-medium text-primary hover:text-primary-strong"
          >
            {contactPath}
          </a>
        ) : (
          <div className="mt-1.5 select-all font-mono text-xs text-ink-muted">
            {contactPath}
          </div>
        ))}

      {guessed && (
        <p className="mt-1.5 text-micro leading-relaxed text-amber">
          Se dedujo del patrón de correos de la empresa: nadie la ha confirmado. Verifícala antes de
          escribirle.
        </p>
      )}
    </div>
  );
}
