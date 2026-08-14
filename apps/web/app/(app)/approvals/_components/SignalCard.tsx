'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { chipClass } from '@/lib/status-chip';
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
        <Radar className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-ink">{company}</div>
          <div className="truncate text-xs text-ink-muted">{roleTitle}</div>
        </div>
        <span className={chipClass('neutral')}>{source}</span>
      </div>

      {excerpt && <p className="text-xs leading-snug text-ink-muted">{excerpt}</p>}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-strong"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Ver la vacante
      </a>

      {status === 'error' && (
        <p className="rounded-sm border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
          {errorMessage} El prospecto sigue igual. Vuelve a intentarlo.
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-border pt-2.5">
        <button
          type="button"
          onClick={() => act('qualified')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill bg-emerald px-3.5 py-1.5 text-xs font-semibold text-white transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
        >
          {status === 'qualifying' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <ThumbsUp className="h-3.5 w-3.5" />
          )}
          Calificar
        </button>
        <button
          type="button"
          onClick={() => act('rejected')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-60"
        >
          {status === 'rejecting' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <ThumbsDown className="h-3.5 w-3.5" />
          )}
          Descartar
        </button>
      </div>
    </div>
  );
}
