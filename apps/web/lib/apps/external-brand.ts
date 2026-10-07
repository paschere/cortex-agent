import 'server-only';
import type { ViewBrand } from '@/lib/branding/shape';
import { readBranding, toViewBrand } from '@/lib/branding/store';
import type { PublishedApp } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** La marca de la empresa para la entrada y las pantallas de afuera: el logo sale por la ruta pública de la app. */
export async function externalBrand(db: SupabaseClient, app: PublishedApp): Promise<ViewBrand> {
  return toViewBrand(
    await readBranding(db),
    app.name,
    (v) => `/api/apps/public/${app.id}/logo?v=${v}`,
  );
}
