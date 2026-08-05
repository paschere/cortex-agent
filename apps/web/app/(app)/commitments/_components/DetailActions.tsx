'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Check, Loader2, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  acknowledgeCommitment,
  confirmCommitment,
  discardCommitment,
  fulfilCommitment,
  moveDueDate,
  rejectCommitment,
} from '../actions';

/**
 * The four things a person can do to a vencimiento, and nothing else.
 *
 * "Cumplido" and "Ya no aplica" are different on purpose: one says the thing
 * happened, the other says it stopped being true. Collapsing them into
 * "cerrar" would make the history unreadable a year later, when somebody is
 * trying to work out whether the SOAT was actually renewed in March or whether
 * the truck had already been sold.
 *
 * Changing the date reopens the notices for the new date, which is why it lives
 * here as a deliberate act with its own field rather than as an inline edit.
 */
export function DetailActions({
  id,
  dueOn,
  closed,
  pending,
  quote,
}: {
  id: string;
  dueOn: string;
  closed: boolean;
  pending: boolean;
  quote: string | null;
}) {
  const [note, setNote] = useState('');
  const [newDate, setNewDate] = useState(dueOn);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'No se pudo completar la acción.');
    });
  }

  if (pending) {
    return (
      <Panel className="border-amber/25 p-5">
        <h2 className="text-sm font-semibold text-ink">Falta confirmarlo</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          {quote
            ? 'Compara la fecha con la frase citada. Si el documento dice eso, confírmalo y queda a tu nombre.'
            : 'Revisa la fecha antes de confirmarla. Al confirmar queda a tu nombre.'}
        </p>
        <div className="mt-3">
          <label className="field-label" htmlFor="corrected-date">
            Fecha correcta
          </label>
          <input
            id="corrected-date"
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className={`${INPUT} tabular mt-1`}
          />
        </div>
        {error && (
          <div role="alert" className="mt-3 text-[12.5px] text-rose">
            {error}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() => confirmCommitment(id, newDate !== dueOn ? newDate : undefined))
            }
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Check className="h-4 w-4" aria-hidden />
            )}
            Confirmar y vigilar
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => run(() => rejectCommitment(id))}
          >
            <X className="h-4 w-4" aria-hidden />
            Descartar la propuesta
          </Button>
        </div>
      </Panel>
    );
  }

  if (closed) {
    return (
      <Panel className="p-5">
        <h2 className="text-sm font-semibold text-ink">Cerrado</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          Este ya no se vigila. Queda como historia; si vuelve a aplicar, registra uno nuevo.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5">
      <h2 className="text-sm font-semibold text-ink">Acciones</h2>

      <div className="mt-3">
        <label className="field-label" htmlFor="met-note">
          ¿Qué se hizo?
        </label>
        <input
          id="met-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Renovado en Seguros Bolívar"
          className={`${INPUT} mt-1`}
        />
      </div>
      <Button
        type="button"
        className="mt-2 w-full"
        disabled={busy}
        onClick={() => run(() => fulfilCommitment(id, note))}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Check className="h-4 w-4" aria-hidden />
        )}
        Marcar como cumplido
      </Button>

      <div className="mt-5 border-t border-border pt-4">
        <label className="field-label" htmlFor="move-date">
          Mover la fecha
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="move-date"
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className={`${INPUT} tabular`}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || newDate === dueOn}
            onClick={() => run(() => moveDueDate(id, newDate))}
          >
            Mover
          </Button>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">
          Cambiar la fecha reabre los avisos: el nuevo plazo vuelve a avisar desde cero.
        </p>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <label className="field-label" htmlFor="drop-reason">
          Ya no aplica
        </label>
        <input
          id="drop-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Vendimos el vehículo"
          className={`${INPUT} mt-1`}
        />
        <Button
          type="button"
          variant="ghost"
          className="mt-2 w-full"
          disabled={busy || !reason.trim()}
          onClick={() => run(() => discardCommitment(id, reason))}
        >
          Descartar
        </Button>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => run(() => acknowledgeCommitment(id))}
        className="mt-4 w-full rounded-pill px-3 py-2 text-[12.5px] font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        Ya lo vi — frena el escalamiento
      </button>

      {error && (
        <div role="alert" className="mt-3 text-[12.5px] text-rose">
          {error}
        </div>
      )}
    </Panel>
  );
}

const INPUT =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/20 motion-reduce:transition-none';
