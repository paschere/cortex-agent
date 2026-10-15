import { AppRunner } from '@/components/apps/AppRunner';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import { previewAttributesOf, requireApp } from '@/lib/apps/access';
import { fontStack } from '@/lib/apps/app-brand';
import { memberAppBrand } from '@/lib/apps/external-brand';
import { previewQuery } from '@/lib/apps/preview-query';
import {
  HOME_NAV,
  appCanExport,
  computePortal,
  computeTablero,
  emptyHintsFor,
  isHomeRoute,
  isPortalRoute,
  loadHome,
  locationStatus,
  navScreens,
  readScreen,
  recordAppEvent,
  screenButtons,
  screenFor,
  tableroForRoute,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';

/**
 * Una pantalla de una aplicación. Los datos se calculan en cada visita con el
 * rol GUARDADO de quien entra (el scope de filas ya viene aplicado por
 * `readScreen`); lo que llega al navegador es sólo lo que ese rol puede ver.
 * `?como=<rol>` es «Ver como…»: sólo un administrador, y todo en sólo lectura.
 * La pantalla viva (refresco, cola sin señal, fotos, dictado) la pone el
 * lienzo de las vistas; aquí sólo se arma el marco de la app.
 */

export interface AppScreenQuery {
  como?: string;
  atr?: string | string[];
  fila?: string;
  d?: string;
}

/**
 * `embedBase`: el panel de la app al lado del chat (/panel/apps/<id>/vista) pinta
 * la misma pantalla sin el espacio de trabajo alrededor; las direcciones de
 * navegación quedan dentro de esa base.
 */
export async function AppScreenServer({
  id,
  screen: screenRef,
  query,
  embedBase,
}: {
  id: string;
  screen: string;
  query: AppScreenQuery;
  embedBase?: (slug: string) => string;
}) {
  const ref = decodeURIComponent(screenRef);
  const opened = await requireApp(decodeURIComponent(id), {
    as: query.como,
    attributes: previewAttributesOf(query.atr),
  });
  const { actor, db, access, readOnly, viewer } = opened;
  // «Inicio» (0215) no es una vista guardada: son las tarjetas de este rol.
  const isHome = isHomeRoute(access, ref);
  // Tablero (0225) y portal de clientes: pantallas sintéticas, calculadas con el rol de quien mira.
  const tableroDef = isHome ? null : tableroForRoute(access, ref);
  const isPortal = !isHome && !tableroDef && isPortalRoute(access, ref);
  const synthetic = isHome || Boolean(tableroDef) || isPortal;
  const screen = synthetic ? null : screenFor(access, ref);
  if (!synthetic && !screen) notFound();
  if (!readOnly) void recordAppEvent(db, access, { kind: 'screen_open', screen: ref });
  const basePath = embedBase ? embedBase(access.app.slug) : `/apps/${access.app.slug}`;
  const [tablero, portal] = await Promise.all([
    tableroDef ? computeTablero(db, access, tableroDef, { basePath }) : null,
    isPortal ? computePortal(db, access, { basePath }) : null,
  ]);
  const [read, home, brand, buttons, location] = await Promise.all([
    screen ? readScreen(db, access, screen, { readOnly, fila: query.fila, detail: query.d }) : null,
    isHome ? loadHome(db, access) : null,
    memberAppBrand(db, actor.organizationName, access.app),
    screen ? screenButtons(db, access.app.id, screen.slug) : [],
    // Compartir ubicación (0216): sólo si la app lo tiene encendido y el rol puede.
    readOnly ? null : locationStatus(db, access),
  ]);
  const emptyHints = screen && read ? await emptyHintsFor(db, access, screen, read) : [];
  const { app, role } = access;
  return (
    <ViewBrandProvider brand={brand}>
      <AppRunner
        app={{ id: app.id, slug: app.slug, name: app.name, icon: app.icon }}
        look={{ font: fontStack(brand.font), iconUrl: brand.iconUrl }}
        emptyHints={emptyHints}
        screens={navScreens(access)}
        current={screen?.slug ?? (synthetic && !isHome ? ref : HOME_NAV.slug)}
        role={{ key: role.key, name: role.name }}
        readOnly={readOnly}
        {...(embedBase ? { embedBase: basePath } : {})}
        previewAttributes={readOnly ? access.user.attributes : undefined}
        canExport={appCanExport(access)}
        canManage={viewer.companyAdmin}
        computed={read?.computed}
        home={home ?? undefined}
        tablero={tablero ?? undefined}
        portal={portal ?? undefined}
        target={screen ? { kind: 'custom_app', appId: app.slug, screen: screen.slug } : undefined}
        dataUrl={
          screen
            ? `/api/apps/${app.slug}/screens/${screen.slug}/data${readOnly ? previewQuery(role.key, access.user.attributes) : ''}`
            : undefined
        }
        title={screen?.title ?? tableroDef?.title ?? (isPortal ? 'Mi portal' : HOME_NAV.title)}
        buttons={buttons}
        location={location?.canShare ? location : null}
        viewer={{ key: access.user.id, name: access.user.name }}
      />
    </ViewBrandProvider>
  );
}
