'use client';

import { confirmationReason } from '@/lib/confirmation-notes';
import { clsx } from 'clsx';
import { Check, ChevronDown, Clock, Loader2, ShieldAlert, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface PendingActionCardProps {
  id: string;
  toolId: string;
  input: unknown;
  expiresAt: string;
  /**
   * Set when this was already answered — including from an Approve/Decline
   * button in Google Chat. The card then states the decision instead of
   * offering a second, conflicting one.
   */
  decision?: 'approved' | 'declined' | null;
  decidedAt?: string | null;
  decidedVia?: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  google_chat: 'desde Google Chat',
  mcp: 'desde tu conversación en Claude',
  web: 'aquí',
};

type Status = 'pending' | 'running' | 'done' | 'declining' | 'declined' | 'error';

/** 'gmail.send_draft' → 'Gmail — Send Draft'. Family prefix capitalized, action Title Cased. */
function humanizeToolId(toolId: string): string {
  const [family, ...rest] = toolId.split('.');
  const titleCase = (s: string) =>
    s
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  const fam = family ? family.charAt(0).toUpperCase() + family.slice(1) : '';
  return rest.length > 0 ? `${fam} — ${titleCase(rest.join('.'))}` : titleCase(toolId);
}

/** Compact time-to-expiry: "quedan 12m", "vencida". */
function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'vencida';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `quedan ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `quedan ${hr}h`;
  return `quedan ${Math.floor(hr / 24)}d`;
}

export function PendingActionCard({
  id,
  toolId,
  input,
  expiresAt,
  decision,
  decidedAt,
  decidedVia,
}: PendingActionCardProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  async function act(action: 'approve' | 'decline') {
    setStatus(action === 'approve' ? 'running' : 'declining');
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Ocurrió un error inesperado.');
        setStatus('error');
        return;
      }
      if (action === 'approve') {
        const data = (await res.json().catch(() => ({}))) as { result?: unknown };
        let compact = '';
        try {
          compact = JSON.stringify(data.result) ?? '';
        } catch {
          compact = String(data.result);
        }
        setResult(compact.length > 600 ? `${compact.slice(0, 600)}…` : compact);
        setStatus('done');
        // Row is already consumed server-side. Skip router.refresh() here so the
        // result stays visible; the list reconciles on the next navigation.
      } else {
        setStatus('declined');
        router.refresh();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'La solicitud falló.');
      setStatus('error');
    }
  }

  const title = humanizeToolId(toolId);

  // ---- Already answered somewhere else (Chat card, Claude, another tab) ----
  // Rendered before any local state so a decision made elsewhere can never be
  // overridden by this tab still showing buttons.
  if (decision) {
    const when = decidedAt
      ? new Date(decidedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;
    const where = decidedVia ? (CHANNEL_LABEL[decidedVia] ?? '') : '';
    const detail = [where, when].filter(Boolean).join(' · ');
    return (
      <div
        className={clsx(
          'flex flex-wrap items-center gap-2 rounded-card border px-4 py-3 text-[13px]',
          decision === 'approved'
            ? 'border-emerald/40 bg-emerald-soft text-emerald'
            : 'border-border bg-surface-2 text-ink-muted',
        )}
      >
        {decision === 'approved' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
        <span className="font-semibold">
          {decision === 'approved' ? 'Aprobada' : 'Rechazada'} — {title}
        </span>
        {detail && <span className="tabular text-[11.5px] text-ink-faint">{detail}</span>}
      </div>
    );
  }

  // ---- Resolved states (compact pills) ----
  if (status === 'done') {
    return (
      <div className="rounded-card border border-emerald/40 bg-emerald-soft px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald">
          <Check className="h-4 w-4 shrink-0" />
          Aprobada y ejecutada — {title}
        </div>
        {result && (
          <pre className="scroll-slim mt-2 max-h-32 overflow-auto rounded-card border border-emerald/30 bg-surface p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
            {result}
          </pre>
        )}
      </div>
    );
  }
  if (status === 'declined') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-4 py-3 text-[13px] text-ink-muted">
        <X className="h-4 w-4" />
        Rechazada — {title} no se ejecutó
      </div>
    );
  }

  const busy = status === 'running' || status === 'declining';

  // ---- Pending / running / error card ----
  return (
    <div className="overflow-hidden rounded-card border border-amber/40 bg-surface">
      <div className="flex items-start gap-3 border-b border-amber/30 bg-amber-soft px-4 py-3">
        <ShieldAlert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="field-label text-amber">Necesita tu confirmación</span>
            <span className="tabular inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-muted">
              <Clock className="h-3 w-3" />
              {timeLeft(expiresAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-ink">{title}</p>
          <p className="mt-1 text-[12px] leading-snug text-ink-muted">
            {confirmationReason(toolId)}
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
          aria-expanded={showDetails}
        >
          <ChevronDown
            className={clsx('h-3.5 w-3.5 transition-transform', showDetails && 'rotate-180')}
          />
          {showDetails ? 'Ocultar los datos' : 'Ver los datos exactos'}
        </button>
        {showDetails && (
          <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-card border border-border bg-surface-2 p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {status === 'error' && (
          <p className="mt-2 rounded-card border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {errorMessage} No se ejecutó nada. Vuelve a intentarlo o rechaza la acción.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => act('approve')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-card bg-amber px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {status === 'running' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                Ejecutando…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />{' '}
                {status === 'error' ? 'Reintentar' : 'Aprobar y ejecutar'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => act('decline')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-card px-3 py-1.5 text-[13px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60"
          >
            {status === 'declining' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                Rechazando…
              </>
            ) : (
              'Rechazar'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
