import 'server-only';
import { appAssetUrl } from '@/lib/apps/app-assets';
import { type AppBrandView, resolveAppBrand } from '@/lib/apps/app-brand';
import { loadSessionBrand, readBranding, toViewBrand } from '@/lib/branding/store';
import type { CustomAppRow, PublishedApp } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La marca para la entrada y las pantallas de afuera: la de la empresa como
 * base (el logo sale por la ruta pública de la app) y encima lo que la app
 * puso en «Apariencia» (0215): logo, colores, nombre corto, letra, bienvenida.
 */
export async function externalBrand(db: SupabaseClient, app: PublishedApp): Promise<AppBrandView> {
  const company = toViewBrand(
    await readBranding(db),
    app.name,
    (v) => `/api/apps/public/${app.id}/logo?v=${v}`,
  );
  return resolveAppBrand(company, app.brand, app, appAssetUrl(app.id, 'public'));
}

/** Lo mismo para quien está dentro con sesión de Cortex (/apps/<app>), incluso en borrador. */
export async function memberAppBrand(
  db: SupabaseClient,
  orgName: string,
  app: Pick<CustomAppRow, 'id' | 'name' | 'brand'>,
): Promise<AppBrandView> {
  const company = await loadSessionBrand(db, orgName);
  return resolveAppBrand(company, app.brand, app, appAssetUrl(app.id, 'member'));
}
