'use client';

import { SUPPORT_STATUSES, SUPPORT_STATUS_LABEL, type SupportStatus } from '@/lib/support/shape';
import { Loader2, Send } from 'lucide-react';
import { useState, useTransition } from 'react';
import { replyTicketAction, setTicketStatusAction } from './actions';

/** Estado y respuesta de un ticket, en la bandeja de soporte. */
export function TicketActions({ id, status }: { id: string; status: SupportStatus }) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-ink-muted" htmlFor={`st-${id}`}>
          Estado
        </label>
        <select
          id={`st-${id}`}
          defaultValue={status}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            start(async () => {
              const r = await setTicketStatusAction(id, next);
              setError(r.ok ? null : r.error);
            });
          }}
          className="h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink"
        >
          {SUPPORT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SUPPORT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reply.trim()) return;
          start(async () => {
            const r = await replyTicketAction(id, reply);
            if (r.ok) {
              setReply('');
              setError(null);
            } else setError(r.error);
          });
        }}
      >
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={2}
          placeholder="Respuesta (le llega por correo y queda en su pantalla de soporte)"
          className="min-w-0 flex-1 resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
        />
        <button
          type="submit"
          disabled={pending || !reply.trim()}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-pill bg-primary px-4 text-sm font-bold text-white disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Responder
        </button>
      </form>
      {error && <p className="text-xs text-rose">{error}</p>}
    </div>
  );
}
