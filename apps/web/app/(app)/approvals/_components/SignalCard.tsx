'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radar, ThumbsUp, ThumbsDown, Loader2, ExternalLink } from 'lucide-react';

interface SignalCardProps {
  id: string;
  company: string;
  roleTitle: string;
  url: string;
  source: string;
  summary: string | null;
}

type Status = 'idle' | 'qualifying' | 'rejecting' | 'error';

export function SignalCard({ id, company, roleTitle, url, source, summary }: SignalCardProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function act(next: 'qualified' | 'rejected') {
    setStatus(next === 'qualified' ? 'qualifying' : 'rejecting');
    try {
      const res = await fetch(`/api/approvals/signals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Unknown error');
        setStatus('error');
        return;
      }
      // Status changed away from 'new' — refresh removes it from the queue.
      router.refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Request failed');
      setStatus('error');
    }
  }

  const busy = status === 'qualifying' || status === 'rejecting';
  const excerpt = summary && summary.length > 220 ? `${summary.slice(0, 220)}…` : summary;

  return (
    <div className="flex h-full flex-col gap-2.5 rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
          <Radar className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-bold text-ink">{company}</div>
          <div className="truncate text-[12.5px] text-ink-muted">{roleTitle}</div>
        </div>
        <span className="shrink-0 rounded-pill bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-faint">
          {source}
        </span>
      </div>

      {excerpt && <p className="text-[12px] leading-snug text-ink-muted">{excerpt}</p>}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:text-primary-strong"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        View posting
      </a>

      {status === 'error' && (
        <p className="rounded-[8px] border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
          {errorMessage}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-border pt-2.5">
        <button
          type="button"
          onClick={() => act('qualified')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill bg-emerald px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {status === 'qualifying' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ThumbsUp className="h-3.5 w-3.5" />
          )}
          Qualify
        </button>
        <button
          type="button"
          onClick={() => act('rejected')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-60"
        >
          {status === 'rejecting' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ThumbsDown className="h-3.5 w-3.5" />
          )}
          Reject
        </button>
      </div>
    </div>
  );
}
