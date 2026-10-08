'use client';

import { AppErrorState } from '@/components/apps/AppErrorState';

/** Si la pantalla falla: qué pasó en una frase y «Reintentar» (0215). */
export default function ScreenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AppErrorState error={error} reset={reset} />;
}
