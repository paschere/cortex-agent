'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function ActivationsError({ reset }: { reset: () => void }) {
  return (
    <div
      className="rounded-card border border-border bg-surface p-8 text-center shadow-card"
      role="alert"
    >
      <AlertTriangle className="mx-auto h-6 w-6 text-amber" aria-hidden />
      <h1 className="mt-3 text-lg font-bold text-ink">Activaciones no está disponible</h1>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
        No pudimos abrir el flujo de revisión. Comprueba la conexión e inténtalo de nuevo.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-sm bg-primary px-4 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <RotateCcw className="h-4 w-4" aria-hidden />
        Intentar de nuevo
      </button>
    </div>
  );
}
