import { PublicShell } from '@/app/v/[token]/PublicShell';
import { AppRunner } from '@/components/apps/AppRunner';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { openApp } from '@/lib/apps/access';
import { externalBrand } from '@/lib/apps/external-brand';
import { openExternalApp } from '@/lib/apps/external-session';
import { appCanExport, readScreen, screenFor, visibleScreens } from '@cortex/agent-tools';
import { notFound, redirect } from 'next/navigation';

/**
 * Una pantalla de la app para un usuario externo (o un miembro que entra por
 * /a/<app>). Es la misma pantalla de /apps/<slug>/<pantalla>: `readScreen` con
 * el rol GUARDADO y su scope de filas ya aplicado. Un usuario externo lee con
 * la barrera del enlace público (nunca Feed ni fuentes internas o personales).
 * Sin sesión, a la entrada; una pantalla que el rol no ve es 404.
 */

export const dynamic = 'force-dynamic';

export default async function ExternalScreenPage({
  params,
}: {
  params: Promise<{ app: string; screen: string }>;
}) {
  const raw = await params;
  const appId = decodeURIComponent(raw.app);
  const screenRef = decodeURIComponent(raw.screen);
  const ext = await openExternalApp(appId);
  if (!ext) notFound();
  const opened = await openApp(ext.app.id);
  if (!opened) redirect(`/a/${ext.app.id}`);
  const screen = screenFor(opened.access, screenRef);
  if (!screen) notFound();
  const { db, access, external, actor } = opened;
  const [{ computed }, brand] = await Promise.all([
    readScreen(db, access, screen),
    externalBrand(db, ext.app),
  ]);
  const { app, role } = access;
  return (
    <PublicShell brand={brand}>
      <ViewBrandProvider brand={brand}>
        <AppRunner
          app={{ id: app.id, slug: app.slug, name: app.name, icon: app.icon }}
          screens={visibleScreens(access).map((s) => ({
            slug: s.slug,
            title: s.title,
            icon: s.icon,
          }))}
          current={screen.slug}
          role={{ key: role.key, name: role.name }}
          readOnly={false}
          canExport={appCanExport(access)}
          canManage={false}
          computed={computed}
          target={{ kind: 'custom_app', appId: app.id, screen: screen.slug, external }}
          dataUrl={`/api/apps/public/${app.id}/screens/${screen.slug}/data`}
          title={screen.title}
          basePath={`/a/${app.id}`}
          session={{ appId: app.id, userKey: actor.id, external, name: actor.name }}
        />
      </ViewBrandProvider>
    </PublicShell>
  );
}
