'use client';

import { type TaskApproval, openApprovals } from '@/lib/background-tasks/status';
import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * Las acciones que la tarea dejó paradas, con su Aprobar / Rechazar. Es el mismo
 * botón de /approvals (POST /api/approvals/[id]): la tarea se entera sola y sigue.
 */
export function TaskApprovals({
  approvals,
  onDecided,
  compact,
}: {
  approvals: TaskApproval[];
  onDecided?: () => void;
  compact?: boolean;
}) {
  const open = openApprovals(approvals);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (open.length === 0) return null;

  async function decide(id: string, action: 'approve' | 'decline') {
    setBusy(id);
    setFailed(null);
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setFailed(
          typeof body.error === 'string' ? body.error : 'No se pudo registrar tu respuesta.',
        );
        return;
      }
      onDecided?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="flex flex-col gap-2">
      {open.map((a) => (
        <li
          key={a.id}
          className="flex flex-wrap items-center gap-3 rounded-card border border-amber/30 bg-amber-soft px-3.5 py-2.5"
        >
          <p className="min-w-0 flex-1 text-sm text-ink [overflow-wrap:anywhere]">{a.summary}</p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-approve
              disabled={busy === a.id}
              onClick={() => void decide(a.id, 'approve')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong disabled:opacity-50 motion-reduce:transition-none"
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              Aprobar
            </button>
            <button
              type="button"
              disabled={busy === a.id}
              onClick={() => void decide(a.id, 'decline')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border disabled:opacity-50 motion-reduce:transition-none"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Rechazar
            </button>
          </div>
        </li>
      ))}
      {failed && <li className="text-xs text-rose">{failed}</li>}
      {!compact && (
        <li className="text-xs text-ink-faint">
          También están en{' '}
          <Link href="/approvals" className="underline">
            Aprobaciones
          </Link>
          . Al responder, la tarea sigue sola.
        </li>
      )}
    </ul>
  );
}
