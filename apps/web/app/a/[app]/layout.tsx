import { openExternalApp } from '@/lib/apps/external-session';
import { appColor, appPath } from '@/lib/apps/manifest';
import { readBranding } from '@/lib/branding/store';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * El marco de /a/<app>: lo que hace que ESTA app, y no Cortex, sea la que se
 * instala. Su manifiesto, su ícono de iPhone y su nombre reemplazan a los del
 * layout raíz mientras la persona está dentro de la app.
 *
 * Y el tema: una app sigue al sistema (claro u oscuro) salvo que la persona
 * haya elegido otra cosa en «Más» (`cortex-app-theme`, 0215). `cortex-workspace`
 * es lo que enciende la paleta oscura (globals.css); el script la decide antes
 * del primer pintado para que no haya un destello blanco.
 */

const THEME_SCRIPT = `try{var t=localStorage.getItem('cortex-app-theme');var d=document.documentElement;if(t==='dark'||t==='light')d.dataset.theme=t;else delete d.dataset.theme}catch(e){}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ app: string }>;
}): Promise<Metadata> {
  const { app: appId } = await params;
  const opened = await openExternalApp(decodeURIComponent(appId));
  if (!opened) return { robots: { index: false, follow: false } };
  const base = appPath(opened.app.id);
  return {
    title: opened.app.name,
    applicationName: opened.app.name,
    manifest: `${base}/manifest.webmanifest`,
    appleWebApp: {
      capable: true,
      title: (opened.app.brand.shortName?.trim() || opened.app.name).slice(0, 12),
      statusBarStyle: 'default',
    },
    icons: {
      icon: [{ url: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png' }],
      apple: `${base}/apple-touch-icon.png`,
    },
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/** La barra del navegador del teléfono lleva el color de la app. */
export async function generateViewport({
  params,
}: {
  params: Promise<{ app: string }>;
}): Promise<Viewport> {
  const { app: appId } = await params;
  const opened = await openExternalApp(decodeURIComponent(appId));
  if (!opened) return {};
  const brand = await readBranding(opened.db).catch(() => null);
  return { themeColor: appColor(opened.app, brand?.primary_color), viewportFit: 'cover' };
}

export default function ExternalAppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="cortex-workspace">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: script fijo, sin datos de nadie */}
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      {children}
    </div>
  );
}
