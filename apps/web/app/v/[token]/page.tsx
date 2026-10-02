import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import { loadPublicBrand } from '@/lib/branding/store';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import {
  canWriteView,
  computeView,
  countPublicOpen,
  loadViewSources,
  parseViewFilterParam,
} from '@cortex/agent-tools';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { PasswordGate } from './PasswordGate';
import { PublicShell as Shell } from './PublicShell';

/**
 * UNA VISTA, VISTA DESDE AFUERA.
 *
 * Fuera del shell de la app a propósito: quien abre esto no es del equipo y no
 * tiene nada que hacer con un menú de Cortex. Ve la marca de la empresa (su
 * logo, su nombre, su color; migración 0170), la vista y una línea al pie.
 * El logo se pide por /api/views/public/logo con ESTE token: sólo el de la
 * empresa dueña de la vista. Los datos se calculan al abrir — un enlace a un
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

export default async function PublicViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ f?: string | string[] }>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const opened = await openPublicView(token);
  if (!opened) notFound();
  const { view, db, organizationName } = opened;
  const brand = await loadPublicBrand(db, organizationName, token);

  if (view.visibility === 'password') {
    const jar = await cookies();
    if (!(await isUnlocked(db, view.id, jar.get(unlockCookieName(view.id))?.value))) {
      return (
        <Shell brand={brand}>
          <PasswordGate token={token} name={view.name} />
        </Shell>
      );
    }
  }

  // `audience: 'public'`: una fuente interna del equipo no se lee aquí aunque
  // la vista la tenga; su bloque sale como aviso (ver loadViewSources). Y en
  // el cálculo: la ficha de una fila sólo trae lo que el bloque ya muestra,
  // salvo que el spec diga `detailFields`. Un enlace con `?f=` abre ya
  // filtrado (validado contra el spec guardado).
  const computed = computeView(
    view.spec,
    await loadViewSources(db, view.spec, { audience: 'public' }),
    new Date(),
    {
      writable: canWriteView(view, 'public'),
      audience: 'public',
      filters: parseViewFilterParam(view.spec, typeof query.f === 'string' ? query.f : null),
    },
  );
  const subtitle = view.spec.subtitle ?? view.description ?? null;
  void countPublicOpen(db, view).catch(() => undefined);

  return (
    <Shell brand={brand}>
      <LiveViewCanvas
        initial={computed}
        target={{ kind: 'public', token }}
        dataUrl={`/api/views/public/data?token=${encodeURIComponent(token)}`}
        heading={{ title: view.name, subtitle }}
        showBrand={false}
      />
      <p className="view-no-print mt-10 border-t border-border pt-4 text-micro text-ink-faint">
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
