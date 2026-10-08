'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { AppIllustration } from './AppIllustration';

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
      className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-3 rounded-[1.75rem] border border-border bg-surface px-6 py-8 text-center shadow-pop"
    >
      <AppIllustration kind="error" />
      <h1 className="text-lg font-extrabold tracking-tight text-ink">{title}</h1>
      <p className="text-sm text-ink-muted">
        Puede ser la señal o un problema nuestro. Lo que ya registraste está guardado.
      </p>
      <button
        type="button"
        onClick={reset}
        className="app-press cortex-primary-button mt-1 inline-flex min-h-12 items-center justify-center gap-2 rounded-pill bg-primary px-6 text-sm font-bold text-white shadow-pop hover:bg-primary-strong"
      >
        <RotateCcw className="h-4 w-4" aria-hidden /> Reintentar
      </button>
    </div>
  );
}
