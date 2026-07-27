'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ExternalLink, ShieldAlert, X } from 'lucide-react';
import { toolLabel } from '@/lib/tool-labels';
import { relativeTime } from '@/lib/relative-time';
import { type AuditEventRow, riskSignals } from '@/app/api/admin/_lib/audit-filters';
import { DecisionPill, RiskPill, SignalChip, StatusPill, SurfacePill } from './pills';
import { absoluteTime, eventDetail, formatLatency, isAgentTurn } from './format';

interface ContextResponse {
  before: AuditEventRow[];
  after: AuditEventRow[];
  scope: 'conversation' | 'user';
  users: Record<string, string>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12.5px] text-ink">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </div>
  );
}

function SequenceRow({
  event,
  current,
  who,
}: {
  event: AuditEventRow;
  current?: boolean;
  who?: string;
}) {
  return (
    <li
      className={clsx(
        'flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-[11.5px]',
        current ? 'bg-primary-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="w-16 shrink-0 text-ink-faint" title={absoluteTime(event.created_at)}>
        {new Date(event.created_at).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
      <span
        className={clsx(
          'min-w-0 flex-1 truncate font-mono',
          current ? 'font-bold text-primary-ink' : 'text-ink-muted',
        )}
      >
        {isAgentTurn(event.tool_id) ? 'chat turn' : event.tool_id}
      </span>
      {who && <span className="hidden shrink-0 truncate text-ink-faint sm:block">{who}</span>}
      <StatusPill status={event.status} />
    </li>
  );
}

/** Everything known about a single audit event, plus its neighbours. */
export function AuditDetailDrawer({
  event,
  userName,
  onClose,
}: {
  event: AuditEventRow | null;
  userName: string;
  onClose: () => void;
}) {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);

  const eventId = event?.id ?? null;

  useEffect(() => {
    if (!eventId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    setContext(null);
    setLoadingContext(true);
    fetch(`/api/admin/audit/${eventId}`)
      .then((r) => (r.ok ? (r.json() as Promise<ContextResponse>) : null))
      .then((json) => {
        if (!cancelled && json) setContext(json);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingContext(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!event) return null;

  const signals = riskSignals(event.risk_signals);
  const detail = eventDetail(event);
  const label = isAgentTurn(event.tool_id) ? 'Chat turn' : toolLabel(event.tool_id).label;
  const metadataJson = JSON.stringify(event.metadata ?? {}, null, 2);
  const risky = event.risk_level === 'high' || event.risk_level === 'critical';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(620px,100vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-bold text-ink">{label}</Dialog.Title>
              <Dialog.Description className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
                <span className="font-mono">{event.tool_id}</span>
                <span>·</span>
                <span>{absoluteTime(event.created_at)}</span>
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close details"
              className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill status={event.status} />
              <SurfacePill surface={event.surface} />
              <RiskPill level={event.risk_level} />
              <DecisionPill decision={event.decision} />
            </div>

            {(event.risk_reason || risky) && (
              <div
                className={clsx(
                  'flex gap-2.5 rounded-card p-3 text-[12.5px]',
                  event.risk_level === 'critical'
                    ? 'bg-rose-soft text-rose'
                    : 'bg-amber-soft text-amber',
                )}
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="min-w-0">
                  {event.risk_reason ?? `Classified ${event.risk_level} risk.`}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Field label="When">
                <span title={absoluteTime(event.created_at)}>{relativeTime(event.created_at)}</span>
              </Field>
              <Field label="Who">{userName}</Field>
              <Field label="Latency">{formatLatency(event.latency_ms)}</Field>
              <Field label="Surface">{event.surface ?? '—'}</Field>
              <Field label="Risk">{event.risk_level ?? '—'}</Field>
              <Field label="Decision">{event.decision ?? '—'}</Field>
              <Field label="Event id">
                <span className="font-mono text-[11px]">{event.id}</span>
              </Field>
              <Field label="Input hash">
                <span className="font-mono text-[11px]">{event.input_hash ?? '—'}</span>
              </Field>
              <Field label="Agent">
                <span className="font-mono text-[11px]">
                  {event.agent_id ? event.agent_id.slice(0, 8) : '—'}
                </span>
              </Field>
            </div>

            {detail && (
              <div>
                <SectionLabel>Detail</SectionLabel>
                <p className="text-[12.5px] text-ink-muted">{detail}</p>
              </div>
            )}

            {signals.length > 0 && (
              <div>
                <SectionLabel>Risk signals</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {signals.map((s) => (
                    <SignalChip key={s}>{s}</SignalChip>
                  ))}
                </div>
              </div>
            )}

            {event.conversation_id && (
              <div>
                <SectionLabel>Conversation</SectionLabel>
                <Link
                  href={`/chat/${event.conversation_id}`}
                  className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary hover:underline"
                >
                  Open the conversation
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}

            <div>
              <SectionLabel>Metadata</SectionLabel>
              <pre className="scroll-slim max-h-64 overflow-auto rounded-card border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
                {metadataJson === '{}' ? 'No metadata recorded.' : metadataJson}
              </pre>
            </div>

            <div>
              <SectionLabel>
                Around this event
                {context ? (context.scope === 'conversation' ? ' · same conversation' : ' · same user') : ''}
              </SectionLabel>
              {loadingContext && <p className="text-[12px] text-ink-faint">Loading sequence…</p>}
              {!loadingContext && !context && (
                <p className="text-[12px] text-ink-faint">Could not load the surrounding events.</p>
              )}
              {context && (
                <ul className="space-y-0.5">
                  {context.before.map((e) => (
                    <SequenceRow key={e.id} event={e} who={context.users[e.user_id]} />
                  ))}
                  <SequenceRow event={event} current who={userName} />
                  {context.after.map((e) => (
                    <SequenceRow key={e.id} event={e} who={context.users[e.user_id]} />
                  ))}
                  {context.before.length === 0 && context.after.length === 0 && (
                    <li className="px-2 py-1.5 text-[12px] text-ink-faint">
                      Nothing else happened around this event.
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
