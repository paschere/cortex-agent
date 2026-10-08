'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

/**
 * UN ERROR QUE SE ENTIENDE (0215): qué pasó en una frase, que los datos están
 * a salvo y un botón para reintentar. Es el cuerpo de los `error.tsx` de las
 * pantallas de una app; el detalle técnico va a la consola, no a la cara de un
 * operario.
 */
export function AppErrorState({
  error,
  reset,
  title = 'No pudimos abrir esta pantalla',
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    console.error('[apps] pantalla con error:', error.digest ?? error.message);
  }, [error]);
  return (
    <div
      role="alert"
      className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 rounded-card border border-border bg-surface p-6 text-center shadow-card"
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-rose-soft text-rose">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h1 className="text-base font-bold text-ink">{title}</h1>
      <p className="text-sm text-ink-muted">
        Puede ser la señal o un problema nuestro. Lo que ya registraste está guardado.
      </p>
      <button
        type="button"
        onClick={reset}
        className="cortex-primary-button inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-primary px-5 text-sm font-semibold text-white shadow-card transition-colors hover:bg-primary-strong"
      >
        <RotateCcw className="h-4 w-4" aria-hidden /> Reintentar
      </button>
    </div>
  );
}
