'use client';

import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { approveRequest, rejectRequest } from './actions';

/**
 * Aprobar manda el correo con un código personal de un solo uso. Si no hay
 * correo configurado (RESEND_API_KEY), el código se muestra AQUÍ una sola vez
 * para mandarlo por otro canal; no se puede volver a leer, sólo regenerar.
 */
export function AccessRequestActions({ id, approved }: { id: string; approved: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setCode(null);
    try {
      const result = await approveRequest(id);
      if (!result.ok) setMessage(result.message);
      else if (result.emailed) setMessage('Aprobada: le llegó el código por correo.');
      else {
        setCode(result.code);
        setMessage('Aprobada, pero no hay correo configurado. Mándale este código:');
      }
    } catch {
      setMessage('No se pudo aprobar. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const result = await rejectRequest(id, null);
      setMessage(result.message);
    } catch {
      setMessage('No se pudo rechazar. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" disabled={busy} onClick={approve} className="px-3 py-1.5 text-xs">
        {approved ? 'Reenviar con código nuevo' : 'Aprobar'}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={reject}
        className="px-3 py-1.5 text-xs"
      >
        Rechazar
      </Button>
      {message && <span className="text-xs text-ink-muted">{message}</span>}
      {code && (
        <code className="rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-ink">
          {code}
        </code>
      )}
    </div>
  );
}
