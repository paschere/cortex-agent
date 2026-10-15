'use client';

import { Loader2 } from 'lucide-react';

/**
 * «SIGUE TRABAJANDO…»: el turno lleva un rato sin traer nada. No es un error —
 * puede ser una herramienta lenta— pero la persona no tiene por qué mirar un
 * círculo girando sin salida: puede detenerlo o repetirlo.
 */
export function StalledNotice({
  onStop,
  onRetry,
}: {
  onStop: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[45rem] shrink-0 px-4 pb-2 sm:px-6">
      <output className="flex w-full min-w-0 flex-wrap items-center gap-3 rounded-card border border-ink/10 bg-surface px-3.5 py-2.5 shadow-card">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink-muted" aria-hidden />
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          Sigue trabajando… esto está tardando más de lo normal.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onStop}
            className="rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-ink hover:text-ink-muted"
          >
            Detener
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-pill bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-strong"
          >
            Reintentar
          </button>
        </div>
      </output>
    </div>
  );
}
