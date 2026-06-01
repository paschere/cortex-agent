'use client';

import { useState } from 'react';
import { ShieldAlert, Check, X, Loader2, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { confirmationSummary } from '@/lib/tool-labels';

interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
  toolCallId?: string;
  onConfirmed?: () => void;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';

export function ConfirmationPrompt({
  conversationId,
  toolId,
  input,
  toolCallId,
  onConfirmed,
}: ConfirmationPromptProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  async function handleAllow() {
    setStatus('running');
    try {
      const res = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, toolId, input, toolCallId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Unknown error');
        setStatus('error');
        return;
      }
      setStatus('allowed');
      onConfirmed?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Request failed');
      setStatus('error');
    }
  }

  const summary = confirmationSummary(
    toolId,
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
  );

  // ---- Resolved states (compact pills) ----
  if (status === 'allowed') {
    return (
      <div className="flex items-center gap-2 rounded-[12px] border border-emerald/30 bg-emerald-soft px-3 py-2 text-[13px] font-medium text-emerald">
        <Check className="h-4 w-4" />
        Done — {summary}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="flex items-center gap-2 rounded-[12px] border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink-faint">
        <X className="h-4 w-4" />
        Dismissed
      </div>
    );
  }

  // ---- Pending / running / error card ----
  return (
    <div className="overflow-hidden rounded-[14px] border border-amber/30 bg-surface shadow-card">
      <div className="flex items-start gap-3 bg-amber-soft px-4 py-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-amber/15 text-amber">
          <ShieldAlert className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-amber">Confirmation required</div>
          <p className="mt-0.5 text-sm font-semibold text-ink">{summary}</p>
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
            onClick={handleAllow}
            disabled={status === 'running'}
            className="inline-flex items-center gap-1.5 rounded-pill bg-amber px-4 py-1.5 text-[13px] font-semibold text-white shadow-pop transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {status === 'running' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" /> {status === 'error' ? 'Retry' : 'Confirm & run'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setStatus('cancelled')}
            disabled={status === 'running'}
            className="rounded-pill px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-60"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
