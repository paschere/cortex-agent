import { AppRunner } from '@/components/apps/AppRunner';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { requireScreen } from '@/lib/apps/access';
import { loadSessionBrand } from '@/lib/branding/store';
import { appCanExport, readScreen, visibleScreens } from '@cortex/agent-tools';

/**
 * Una pantalla de una aplicación. Los datos se calculan en cada visita con el
 * rol GUARDADO de quien entra (el scope de filas ya viene aplicado por
 * `readScreen`); lo que llega al navegador es sólo lo que ese rol puede ver.
 * `?como=<rol>` es «Ver como…»: sólo un administrador, y todo en sólo lectura.
 * La pantalla viva (refresco, cola sin señal, fotos, dictado) la pone el
 * lienzo de las vistas; aquí sólo se arma el marco de la app.
 */

export const dynamic = 'force-dynamic';

export default async function AppScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; screen: string }>;
  searchParams: Promise<{ como?: string }>;
}) {
  const [{ id, screen: screenRef }, query] = await Promise.all([params, searchParams]);
  const { user, db, access, screen, readOnly, viewer } = await requireScreen(
    decodeURIComponent(id),
    decodeURIComponent(screenRef),
    { as: query.como },
  );
  const [{ computed }, brand] = await Promise.all([
    readScreen(db, access, screen, { readOnly }),
    loadSessionBrand(db, user.organization.name),
  ]);
  const { app, role } = access;
  return (
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
        readOnly={readOnly}
        canExport={appCanExport(access)}
        canManage={viewer.companyAdmin}
        computed={computed}
        target={{ kind: 'custom_app', appId: app.slug, screen: screen.slug }}
        dataUrl={`/api/apps/${app.slug}/screens/${screen.slug}/data${readOnly ? `?como=${encodeURIComponent(role.key)}` : ''}`}
        title={screen.title}
      />
    </ViewBrandProvider>
  );
}
