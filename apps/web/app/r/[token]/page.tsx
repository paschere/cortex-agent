import { ReplayView } from '@/components/replay/ReplayView';
import { openReplay } from '@/lib/task-share/public';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/**
 * LA REPETICIÓN DE UNA TAREA, VISTA DESDE AFUERA.
 *
 * Fuera del shell de la app: quien la abre no tiene cuenta. Sólo lectura, sin
 * indexar, sin referer. Un enlace que no abre (mal escrito, vencido, revocado)
 * es un 404 sin explicar cuál de los tres.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Repetición de una tarea',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ReplayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openReplay(token);
  if (!opened) notFound();
  return (
    <main className="cortex-workspace min-h-screen bg-canvas">
      <span aria-hidden className="block h-1 bg-primary" />
      <ReplayView
        snapshot={opened.snapshot}
        expiresAt={opened.expiresAt}
        shotUrl={(key) => `/r/${encodeURIComponent(token)}/shot/${encodeURIComponent(key)}`}
      />
    </main>
  );
}
