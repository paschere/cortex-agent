'use client';

import { type ConnectionState, connectionLabel } from '@/lib/forms/connection-state';
import { clsx } from 'clsx';
import { CloudOff, Loader2, RefreshCw } from 'lucide-react';

/**
 * La píldora del estado de la conexión de un formulario: «En línea», «Sin
 * conexión · 3 registros por enviar», «Reconectando…». Dice la verdad en pocas
 * palabras (ver lib/forms/connection-state.ts) y, cuando hay algo por enviar y
 * hay red, ofrece «Reintentar ahora». `role="status"`: el lector de pantalla
 * anuncia el cambio sin robarle el foco a nadie.
 */
export function ConnectionPill({
  state,
  pending,
  syncing = false,
  onRetry,
  className,
}: {
  state: ConnectionState;
  pending: number;
  syncing?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  const label = connectionLabel(state, pending, syncing);
  const canRetry = Boolean(onRetry) && state !== 'offline' && pending > 0 && !syncing;
  return (
    <span
      role="status"
      title={label.detail}
      className={clsx(
        'inline-flex min-h-8 items-center gap-2 rounded-pill border px-3 text-micro font-semibold',
        label.tone === 'ok' && 'border-transparent bg-transparent px-1 text-ink-faint',
        label.tone === 'warn' && 'border-amber/40 bg-amber-soft text-amber',
        label.tone === 'busy' && 'border-primary/30 bg-primary-soft text-primary-ink',
        className,
      )}
    >
      {label.tone === 'busy' ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : label.tone === 'warn' && state === 'offline' ? (
        <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <span
          aria-hidden
          className={clsx(
            'h-2 w-2 shrink-0 rounded-pill',
            label.tone === 'ok' ? 'bg-emerald' : 'bg-amber',
          )}
        />
      )}
      <span>{label.text}</span>
      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="-mr-1 inline-flex h-6 items-center gap-1 rounded-pill border border-border-strong px-2 text-micro font-semibold hover:bg-surface/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Reintentar ahora
        </button>
      )}
    </span>
  );
}
