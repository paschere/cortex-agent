'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, Check, X, Loader2, ChevronDown, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { confirmationReason } from '@/lib/confirmation-notes';

interface PendingActionCardProps {
  id: string;
  toolId: string;
  input: unknown;
  expiresAt: string;
}

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

/** Compact time-to-expiry: "12m left", "3h left", "expired". */
function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min}m left`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h left`;
  return `${Math.floor(hr / 24)}d left`;
}

export function PendingActionCard({ id, toolId, input, expiresAt }: PendingActionCardProps) {
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
        setErrorMessage((data as { error?: string }).error ?? 'Unknown error');
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
      setErrorMessage(err instanceof Error ? err.message : 'Request failed');
      setStatus('error');
    }
  }

  const title = humanizeToolId(toolId);

  // ---- Resolved states (compact pills) ----
  if (status === 'done') {
    return (
      <div className="rounded-[14px] border border-emerald/30 bg-emerald-soft px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald">
          <Check className="h-4 w-4 shrink-0" />
          Done — {title} ran successfully
        </div>
        {result && (
          <pre className="scroll-slim mt-2 max-h-32 overflow-auto rounded-[8px] border border-emerald/20 bg-surface p-2 text-[10px] leading-relaxed text-ink-muted">
            {result}
          </pre>
        )}
      </div>
    );
  }
  if (status === 'declined') {
    return (
      <div className="flex items-center gap-2 rounded-[14px] border border-border bg-surface-2 px-4 py-3 text-[13px] text-ink-faint">
        <X className="h-4 w-4" />
        Declined — {title} was not executed
      </div>
    );
  }

  const busy = status === 'running' || status === 'declining';

  // ---- Pending / running / error card ----
  return (
    <div className="overflow-hidden rounded-[14px] border border-amber/30 bg-surface shadow-card">
      <div className="flex items-start gap-3 bg-amber-soft px-4 py-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-amber/15 text-amber">
          <ShieldAlert className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber">
              Confirmation required
            </span>
            <span className="inline-flex items-center gap-1 rounded-pill bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">
              <Clock className="h-3 w-3" />
              {timeLeft(expiresAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-ink">{title}</p>
          <p className="mt-1 text-[12px] leading-snug text-ink-muted">{confirmationReason(toolId)}</p>
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink-muted"
        >
          <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', showDetails && 'rotate-180')} />
          {showDetails ? 'Hide' : 'Show'} payload
        </button>
        {showDetails && (
          <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-[8px] border border-border bg-surface-2 p-2 text-[10px] leading-relaxed text-ink-muted">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {status === 'error' && (
          <p className="mt-2 rounded-[8px] border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {errorMessage}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => act('approve')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill bg-amber px-4 py-1.5 text-[13px] font-semibold text-white shadow-pop transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {status === 'running' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" /> {status === 'error' ? 'Retry' : 'Approve & run'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => act('decline')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-60"
          >
            {status === 'declining' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Declining…
              </>
            ) : (
              'Decline'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
