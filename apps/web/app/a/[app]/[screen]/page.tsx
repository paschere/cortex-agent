import { PublicShell } from '@/app/v/[token]/PublicShell';
import { AppRunner } from '@/components/apps/AppRunner';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { openApp } from '@/lib/apps/access';
import { fontStack } from '@/lib/apps/app-brand';
import { externalBrand } from '@/lib/apps/external-brand';
import { openExternalApp } from '@/lib/apps/external-session';
import {
  HOME_NAV,
  appCanExport,
  canEnrollKiosk,
  emptyHintsFor,
  entrySlug,
  getKioskSettings,
  isHomeRoute,
  loadHome,
  navScreens,
  readScreen,
  screenButtons,
  screenFor,
} from '@cortex/agent-tools';
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
  searchParams,
}: {
  params: Promise<{ app: string; screen: string }>;
  searchParams: Promise<{ fila?: string; d?: string }>;
}) {
  const [raw, query] = await Promise.all([params, searchParams]);
  const appId = decodeURIComponent(raw.app);
  const screenRef = decodeURIComponent(raw.screen);
  const ext = await openExternalApp(appId);
  if (!ext) notFound();
  const opened = await openApp(ext.app.id);
  if (!opened) redirect(`/a/${ext.app.id}`);
  // «Inicio» (0215) no es una vista guardada: son las tarjetas de este rol.
  const isHome = isHomeRoute(opened.access, screenRef);
  const screen = isHome ? null : screenFor(opened.access, screenRef);
  if (!isHome && !screen) notFound();
  const { db, access, external, actor, kiosk } = opened;
  const [read, home, brand, kioskSettings, buttons] = await Promise.all([
    screen ? readScreen(db, access, screen, { fila: query.fila, detail: query.d }) : null,
    isHome ? loadHome(db, access) : null,
    externalBrand(db, ext.app),
    external ? getKioskSettings(db, ext.app.id) : null,
    screen ? screenButtons(db, ext.app.id, screen.slug) : [],
  ]);
  const emptyHints = screen && read ? await emptyHintsFor(db, access, screen, read) : [];
  const { app, role } = access;
  return (
    <div style={{ fontFamily: fontStack(brand.font) }}>
      <PublicShell brand={brand} mobileBar={false}>
        <ViewBrandProvider brand={brand}>
          <AppRunner
            app={{ id: app.id, slug: app.slug, name: app.name, icon: app.icon }}
            look={{ font: fontStack(brand.font), iconUrl: brand.iconUrl }}
            emptyHints={emptyHints}
            screens={navScreens(access)}
            current={screen?.slug ?? HOME_NAV.slug}
            role={{ key: role.key, name: role.name }}
            readOnly={false}
            canExport={appCanExport(access)}
            canManage={false}
            computed={read?.computed}
            home={home ?? undefined}
            target={
              screen
                ? { kind: 'custom_app', appId: app.id, screen: screen.slug, external }
                : undefined
            }
            dataUrl={screen ? `/api/apps/public/${app.id}/screens/${screen.slug}/data` : undefined}
            title={screen?.title ?? HOME_NAV.title}
            basePath={`/a/${app.id}`}
            buttons={buttons}
            session={{
              appId: app.id,
              userKey: actor.id,
              external,
              name: actor.name,
              homeSlug: entrySlug(access, screenFor(access, null)),
              kiosk: kiosk ?? null,
              kioskEnabled: kioskSettings?.enabled ?? false,
              canEnrollKiosk: Boolean(kioskSettings?.enabled) && canEnrollKiosk(role),
            }}
          />
        </ViewBrandProvider>
      </PublicShell>
    </div>
  );
}
