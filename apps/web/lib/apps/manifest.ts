import { CORTEX_PRIMARY, normalizeHex } from '@/lib/branding/colors';

/**
 * EL MANIFIESTO DE UNA APP INSTALABLE (0209), PURO Y PROBADO.
 *
 * Cada app tiene el suyo: `start_url` y `scope` son /a/<app>, así que instalar
 * «Control en planta» y «Portal de clientes» deja dos íconos distintos que
 * abren cada uno SU app y ninguna otra. El nombre y el color salen de la app y
 * de la marca de la empresa (company_branding, 0170).
 */

/** El acento de la app (theme.accent) en hex, para quien no tiene color de marca. */
const ACCENTS: Record<string, string> = {
  primary: CORTEX_PRIMARY,
  emerald: '#047857',
  amber: '#b45309',
  sky: '#0369a1',
  rose: '#be123c',
};

export const MANIFEST_BACKGROUND = '#f7f7fb';

/** El color de la app: el de la marca de la empresa si lo puso, si no el acento del tema. */
export function appColor(
  app: { theme?: { accent?: string } },
  brandPrimary: string | null | undefined,
): string {
  return normalizeHex(brandPrimary) ?? ACCENTS[app.theme?.accent ?? 'primary'] ?? CORTEX_PRIMARY;
}

export function appPath(appId: string): string {
  return `/a/${encodeURIComponent(appId)}`;
}

export interface AppManifestInput {
  id: string;
  name: string;
  description: string;
  theme?: { accent?: string };
}

export function buildAppManifest(app: AppManifestInput, brandPrimary?: string | null) {
  const base = appPath(app.id);
  const name = app.name.trim().slice(0, 80) || 'Aplicación';
  return {
    id: base,
    name,
    short_name: name.slice(0, 12),
    description: app.description.trim().slice(0, 200) || `${name}, una aplicación de tu empresa.`,
    start_url: base,
    scope: `${base}/`,
    display: 'standalone' as const,
    orientation: 'portrait-primary' as const,
    lang: 'es-CO',
    dir: 'ltr' as const,
    background_color: MANIFEST_BACKGROUND,
    theme_color: appColor(app, brandPrimary),
    categories: ['business', 'productivity'],
    icons: [
      { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: `${base}/icon-maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
