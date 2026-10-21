'use client';

import { AppErrorState } from '@/components/apps/AppErrorState';

/** Si algo falla al abrir esto: qué pasó en una frase y «Reintentar», con el estilo del sistema. */
export default function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AppErrorState error={error} reset={reset} title="No pudimos abrir esto" />;
}
