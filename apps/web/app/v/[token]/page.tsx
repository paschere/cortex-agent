import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { canWriteView, computeView, countPublicOpen, loadViewSources } from '@cortex/agent-tools';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { PasswordGate } from './PasswordGate';

/**
 * UNA VISTA, VISTA DESDE AFUERA.
 *
 * Fuera del shell de la app a propósito: quien abre esto no es del equipo y no
 * tiene nada que hacer con un menú de Cortex. Ve el nombre de la empresa, la
 * vista y una línea al pie. Los datos se calculan al abrir — un enlace a un
 * tablero muestra el tablero de hoy, no el del día en que se compartió — con
 * un handle del espacio de la vista; ver lib/views/public.ts.
 *
 * Un token que no abre (revocado, vencido, archivado, inventado) es 404 sin
 * más explicación: afuera no se distingue «nunca existió» de «ya no está».
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PublicViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openPublicView(token);
  if (!opened) notFound();
  const { view, db, organizationName } = opened;

  if (view.visibility === 'password') {
    const jar = await cookies();
    if (!(await isUnlocked(db, view.id, jar.get(unlockCookieName(view.id))?.value))) {
      return (
        <Shell organization={organizationName}>
          <PasswordGate token={token} name={view.name} />
        </Shell>
      );
    }
  }

  // `audience: 'public'`: una fuente interna del equipo no se lee aquí aunque
  // la vista la tenga; su bloque sale como aviso (ver loadViewSources).
  const computed = computeView(
    view.spec,
    await loadViewSources(db, view.spec, { audience: 'public' }),
    new Date(),
    { writable: canWriteView(view, 'public') },
  );
  void countPublicOpen(db, view).catch(() => undefined);

  return (
    <Shell organization={organizationName}>
      <header className="mb-6">
        <h1 className="text-xl font-bold tracking-tight text-ink">{view.name}</h1>
        {(view.spec.subtitle || view.description) && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            {view.spec.subtitle ?? view.description}
          </p>
        )}
      </header>
      <LiveViewCanvas
        initial={computed}
        target={{ kind: 'public', token }}
        dataUrl={`/api/views/public/data?token=${encodeURIComponent(token)}`}
      />
      <p className="mt-8 text-micro text-ink-faint">
        Datos al{' '}
        {new Intl.DateTimeFormat('es-CO', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: 'America/Bogota',
        }).format(new Date(computed.computedAt))}
        .
      </p>
    </Shell>
  );
}

function Shell({ organization, children }: { organization: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="truncate text-sm font-semibold text-ink">{organization}</span>
          <span className="shrink-0 text-micro text-ink-faint">Hecho con Cortex</span>
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
