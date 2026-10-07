import { openExternalApp } from '@/lib/apps/external-session';
import { appPath } from '@/lib/apps/manifest';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * El marco de /a/<app>: lo que hace que ESTA app, y no Cortex, sea la que se
 * instala. Su manifiesto, su ícono de iPhone y su nombre reemplazan a los del
 * layout raíz mientras la persona está dentro de la app.
 */

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
    appleWebApp: { capable: true, title: opened.app.name.slice(0, 12), statusBarStyle: 'default' },
    icons: {
      icon: [{ url: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png' }],
      apple: `${base}/apple-touch-icon.png`,
    },
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default function ExternalAppLayout({ children }: { children: ReactNode }) {
  return children;
}
