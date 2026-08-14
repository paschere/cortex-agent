'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ExternalLink, ShieldAlert, X } from 'lucide-react';
import { toolLabel } from '@/lib/tool-labels';
import { relativeTime } from '@/lib/relative-time';
import { type AuditEventRow, riskSignals } from '@/app/api/admin/_lib/audit-filters';
import { Provenance } from '@/components/ui/provenance';
import { DecisionTag, RiskTag, SignalChip, StatusTag, SurfaceTag } from './tags';
import { absoluteTime, eventDetail, formatLatency, isAgentTurn } from './format';

/** Where the call came in from — the stamp's "system of record". */
const SOURCE_LABEL: Record<string, string> = {
  web: 'CORTEX WEB',
  mcp: 'CLAUDE',
  schedule: 'RUTINA',
};

interface ContextResponse {
  before: AuditEventRow[];
  after: AuditEventRow[];
  scope: 'conversation' | 'user';
  users: Record<string, string>;
}

/**
 * Local rather than the shared `<Field>`: nine of these sit three-across in a
 * 620px drawer, so the value has to truncate and sit at the drawer's own size.
 * It keeps the same contract — `.field-label` above, monospaced value below.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="field-label">{label}</div>
      <div className="tabular mt-0.5 truncate text-xs text-ink">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="field-label mb-2">{children}</div>;
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
        'flex items-center gap-2 rounded-sm px-2 py-1.5 text-micro transition-colors',
        current ? 'bg-primary-soft' : 'hover:bg-surface-2',
      )}
    >
      <span
        className="tabular w-16 shrink-0 text-ink-faint"
        title={absoluteTime(event.created_at)}
      >
        {new Date(event.created_at).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
      <span
        className={clsx(
          'tabular min-w-0 flex-1 truncate',
          current ? 'font-bold text-primary-ink' : 'text-ink-muted',
        )}
      >
        {isAgentTurn(event.tool_id) ? 'turno de chat' : event.tool_id}
      </span>
      {who && <span className="hidden shrink-0 truncate text-ink-faint sm:block">{who}</span>}
      <StatusTag status={event.status} />
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
  const label = isAgentTurn(event.tool_id) ? 'Turno de chat' : toolLabel(event.tool_id).label;
  const metadataJson = JSON.stringify(event.metadata ?? {}, null, 2);
  const risky = event.risk_level === 'high' || event.risk_level === 'critical';
  // The one place on this screen with real provenance to show: this row IS the
  // record of what ran, when, and on whose behalf. It goes on the single event
  // being examined, never on the 200 rows of the table — a stamp repeated that
  // often stops meaning anything.
  const stoppedIt = event.decision === 'blocked' || event.status === 'error';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(620px,100vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-bold text-ink">{label}</Dialog.Title>
              <Dialog.Description className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
                <span className="font-mono">{event.tool_id}</span>
                <span>·</span>
                <span>{absoluteTime(event.created_at)}</span>
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar el detalle"
              className="rounded-full p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <Provenance
              source={SOURCE_LABEL[event.surface ?? ''] ?? 'CORTEX'}
              readAt={absoluteTime(event.created_at)}
              detail={`a nombre de ${userName}`}
              tone={stoppedIt ? 'seal' : 'stamp'}
            />

            <div className="flex flex-wrap items-center gap-1.5">
              <StatusTag status={event.status} />
              <SurfaceTag surface={event.surface} />
              <RiskTag level={event.risk_level} />
              <DecisionTag decision={event.decision} />
            </div>

            {(event.risk_reason || risky) && (
              <div
                className={clsx(
                  'flex gap-2.5 rounded-sm p-3 text-xs',
                  event.risk_level === 'critical'
                    ? 'bg-rose-soft text-rose'
                    : 'bg-amber-soft text-amber',
                )}
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="min-w-0">
                  {event.risk_reason ?? `Clasificado como riesgo ${event.risk_level}.`}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Field label="Cuándo">
                <span title={absoluteTime(event.created_at)}>{relativeTime(event.created_at)}</span>
              </Field>
              <Field label="Quién">{userName}</Field>
              <Field label="Latencia">{formatLatency(event.latency_ms)}</Field>
              <Field label="Superficie">{event.surface ?? '—'}</Field>
              <Field label="Riesgo">{event.risk_level ?? '—'}</Field>
              <Field label="Decisión">{event.decision ?? '—'}</Field>
              <Field label="Id del evento">
                <span className="text-micro">{event.id}</span>
              </Field>
              <Field label="Hash de entrada">
                <span className="text-micro">{event.input_hash ?? '—'}</span>
              </Field>
              <Field label="Agente">
                <span className="text-micro">
                  {event.agent_id ? event.agent_id.slice(0, 8) : '—'}
                </span>
              </Field>
            </div>

            {detail && (
              <div>
                <SectionLabel>Detalle</SectionLabel>
                <p className="text-xs text-ink-muted">{detail}</p>
              </div>
            )}

            {signals.length > 0 && (
              <div>
                <SectionLabel>Señales de riesgo</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {signals.map((s) => (
                    <SignalChip key={s}>{s}</SignalChip>
                  ))}
                </div>
              </div>
            )}

            {event.conversation_id && (
              <div>
                <SectionLabel>Conversación</SectionLabel>
                <Link
                  href={`/chat/${event.conversation_id}`}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  Abrir la conversación
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}

            <div>
              <SectionLabel>Metadatos</SectionLabel>
              <pre className="scroll-slim max-h-64 overflow-auto rounded-card border border-border bg-surface-2 p-3 font-mono text-micro leading-relaxed text-ink-muted">
                {metadataJson === '{}' ? 'No se registraron metadatos.' : metadataJson}
              </pre>
            </div>

            <div>
              <SectionLabel>
                Alrededor de este evento
                {context
                  ? context.scope === 'conversation'
                    ? ' · misma conversación'
                    : ' · mismo usuario'
                  : ''}
              </SectionLabel>
              {loadingContext && <p className="text-xs text-ink-faint">Cargando la secuencia…</p>}
              {!loadingContext && !context && (
                <p className="text-xs text-ink-muted">
                  No se pudieron cargar los eventos vecinos. Cierra y vuelve a abrir el detalle.
                </p>
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
                    <li className="px-2 py-1.5 text-xs text-ink-faint">
                      No pasó nada más alrededor de este evento.
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
