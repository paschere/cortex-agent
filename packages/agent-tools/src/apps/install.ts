import type { SupabaseClient } from '@supabase/supabase-js';
import { defineTracker, getTrackerBySlug } from '../trackers/store';
import {
  type AppScreenRow,
  type CustomAppRow,
  addScreen,
  createApp,
  saveRoles,
  updateApp,
} from './store';
import type { AppTemplate } from './templates';

/**
 * Montar una app desde una plantilla, o desde lo que el diseñador armó: las
 * tablas que falten se crean (nunca se le cambia el esquema a una que ya
 * existe: eso sigue siendo `trackers.define`, con su confirmación), luego la
 * app, sus roles y sus pantallas en orden. Si una pantalla no pasa el
 * catálogo, la app queda creada con las anteriores y el error dice cuál.
 */
export async function installAppTemplate(
  db: SupabaseClient,
  template: AppTemplate,
  input: { userId: string; name?: string; description?: string },
): Promise<{ app: CustomAppRow; screens: AppScreenRow[]; createdTrackers: string[] }> {
  const createdTrackers: string[] = [];
  for (const t of template.trackers) {
    if (await getTrackerBySlug(db, t.slug)) continue;
    await defineTracker(db, { ...t, userId: input.userId });
    createdTrackers.push(t.slug);
  }
  const app = await createApp(db, {
    name: input.name ?? template.name,
    description: input.description ?? template.body,
    icon: template.icon,
    theme: { accent: template.accent },
    userId: input.userId,
  });
  await saveRoles(db, app.id, template.roles);
  const screens: AppScreenRow[] = [];
  for (const s of template.screens) {
    screens.push(
      await addScreen(db, app, {
        title: s.title,
        slug: s.slug,
        icon: s.icon,
        roles: s.roles,
        spec: s.spec,
        userId: input.userId,
        prompt: `Plantilla «${template.name}»`,
      }),
    );
  }
  const home = screens.find((s) => s.slug === template.homeScreen);
  const updated = await updateApp(db, app.id, {
    homeScreen: home?.slug ?? null,
    location: template.location,
    userId: input.userId,
  });
  return { app: updated, screens, createdTrackers };
}
