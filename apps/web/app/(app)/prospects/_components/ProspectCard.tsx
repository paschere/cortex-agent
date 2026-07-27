'use client';

import { relativeTime } from '@/lib/relative-time';
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
import { CompanyResearch } from './CompanyResearch';
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
    { next: 'qualified', label: 'Qualify', primary: true },
    { next: 'rejected', label: 'Not a fit' },
  ],
  qualified: [
    { next: 'contacted', label: 'Mark contacted', primary: true },
    { next: 'rejected', label: 'Not a fit' },
  ],
  contacted: [
    { next: 'qualified', label: 'Back to qualified' },
    { next: 'rejected', label: 'Not a fit' },
  ],
  rejected: [
    { next: 'new', label: 'Put back in New' },
    { next: 'qualified', label: 'Qualify after all' },
  ],
};

export function ProspectCard({
  prospect,
  busyWith,
  error,
  apolloAvailable,
  filedAway,
  onMove,
}: {
  prospect: Prospect;
  busyWith: SignalStatus | null;
  error: string | null;
  apolloAvailable: boolean;
  /** True when the row only survives the current filter because it just moved. */
  filedAway: boolean;
  onMove: (next: SignalStatus) => void;
}) {
  const meta = STATUS_META[prospect.status];
  const Icon = meta.icon;

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      {/* ------------------------------------------------------------ header */}
      <div className="flex items-start gap-3">
        <span
          className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-[10px]', meta.chip)}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14.5px] font-bold text-ink">{prospect.company}</span>
            <span className={clsx('rounded-pill px-2 py-0.5 text-[10.5px] font-bold', meta.chip)}>
              {meta.label}
            </span>
          </div>
          <div className="mt-0.5 text-[13px] text-ink-muted">
            hiring a <span className="font-semibold text-ink">{prospect.roleTitle}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
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
            <span>found {relativeTime(prospect.createdAt)}</span>
            {prospect.reviewedAt && prospect.status !== 'new' && (
              <span>
                {meta.done.toLowerCase()}
                {prospect.reviewerName ? ` by ${prospect.reviewerName}` : ''}{' '}
                {relativeTime(prospect.reviewedAt)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Answers "did it disappear?" in the place the question gets asked. */}
      {filedAway && (
        <p className="mt-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[11.5px] text-ink-muted">
          Filed under <b className="text-ink">{meta.label}</b> — still here, and it will be under
          that tab next time you look.
        </p>
      )}

      {/* ---------------------------------------------------------- evidence */}
      {prospect.summary && (
        <div className="mt-3 rounded-[10px] bg-surface-2 px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            <Quote className="h-3 w-3" />
            Why it looks like a fit
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">{prospect.summary}</p>
        </div>
      )}

      {/* ----------------------------------------------------------- contact */}
      <Contact prospect={prospect} />

      {error && (
        <p className="mt-3 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
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
                'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60',
                action.primary
                  ? 'bg-primary text-white shadow-pop hover:bg-primary-strong'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {action.label}
            </button>
          );
        })}
      </div>

      <CompanyResearch
        signalId={prospect.id}
        company={prospect.company}
        available={apolloAvailable}
      />
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
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-faint">
        <UserSearch className="h-3.5 w-3.5" />
        No contact yet — ask Zippy who is hiring for this role.
      </p>
    );
  }

  const verified = contactConfidence === 'found';
  const guessed = contactConfidence === 'inferred';
  const isEmail = !!contactPath?.includes('@');

  return (
    <div className="mt-3 rounded-[10px] border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <UserRound className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-[12.5px] font-semibold text-ink">{contactName ?? 'Contact'}</span>
        {contactTitle && <span className="text-[12px] text-ink-muted">· {contactTitle}</span>}
        <span
          className={clsx(
            'ml-auto inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[10.5px] font-bold',
            verified
              ? 'bg-emerald-soft text-emerald'
              : guessed
                ? 'bg-amber-soft text-amber'
                : 'bg-surface-2 text-ink-faint',
          )}
        >
          {verified ? (
            <ShieldCheck className="h-3 w-3" />
          ) : guessed ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          {verified ? 'Seen publicly' : guessed ? 'Not verified' : 'Unconfirmed'}
        </span>
      </div>

      {contactPath &&
        (verified && isEmail ? (
          <a
            href={`mailto:${contactPath}`}
            className="mt-1.5 inline-block text-[12.5px] font-medium text-primary hover:text-primary-strong"
          >
            {contactPath}
          </a>
        ) : (
          <div className="mt-1.5 select-all font-mono text-[12px] text-ink-muted">
            {contactPath}
          </div>
        ))}

      {guessed && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-amber">
          Worked out from how the company usually builds addresses — nobody has confirmed this one.
          Check it before you send anything to it.
        </p>
      )}
    </div>
  );
}
