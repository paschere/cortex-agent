'use client';

import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { cancelPlan, resumePlan } from '../actions';

/**
 * Cancelar o reanudar. Cancelar nunca corta: todo sigue hasta el final de lo
 * pagado (o de la prueba) y después el espacio queda en solo lectura con todos
 * sus datos. Se pide confirmación con esa misma frase.
 */
export function BillingControls({ canceling }: { canceling: boolean }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    try {
      const result = await action();
      setMessage(result.message);
    } catch {
      setMessage('No se pudo hacer el cambio. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (canceling) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => run(resumePlan)}>
          {busy ? 'Reanudando…' : 'Reanudar el plan'}
        </Button>
        {message && <span className="text-xs text-ink-muted">{message}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {confirming ? (
        <>
          <span className="text-xs text-ink-muted">
            Todo sigue funcionando hasta el final de lo pagado; después, solo lectura. ¿Cancelar?
          </span>
          <Button type="button" variant="outline" disabled={busy} onClick={() => run(cancelPlan)}>
            {busy ? 'Cancelando…' : 'Sí, cancelar'}
          </Button>
          <button
            type="button"
            className="text-xs font-semibold text-ink-muted hover:text-ink"
            onClick={() => setConfirming(false)}
          >
            No
          </button>
        </>
      ) : (
        <button
          type="button"
          className="text-xs font-semibold text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          onClick={() => setConfirming(true)}
        >
          Cancelar el plan
        </button>
      )}
      {message && <span className="text-xs text-ink-muted">{message}</span>}
    </div>
  );
}
