import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type TrackerField, displayTrackerValue } from '../trackers/schema';
import { getTrackerBySlug } from '../trackers/store';
import type { ComputedView } from '../views/compute';
import { type CatalogTracker, trackersOf } from '../views/spec';
import type { ViewFilterState } from '../views/view-filters';
import type { AppDraft } from './design';
import { buildAppPreview } from './draft';
import type { AppAccess, AppScreenRow } from './store';
import { screenView } from './store';

/**
 * UNA PANTALLA DE UNA APP REAL, CON DATOS DE PRUEBA («Ver como…» en modo prueba).
 *
 * Es la misma app (su spec guardado, el rol que se mira con SUS permisos y el
 * esquema real de las tablas) pero las filas salen de `sample-data.ts`: nunca
 * se leen filas reales y nunca se escribe. Reusa `buildAppPreview`, el cálculo
 * de la vista previa de un borrador, para que «Ver como» en el editor, en la
 * vista previa del chat y en la app real digan lo mismo.
 */

export interface SampleScreen {
  computed: ComputedView;
  samples: Array<{ slug: string; name: string; rows: number }>;
  notes: string[];
}

export async function readScreenSample(
  db: SupabaseClient,
  access: AppAccess,
  screen: AppScreenRow,
  options: {
    fila?: string | null;
    detail?: string | null;
    filters?: ViewFilterState;
    now?: Date;
  } = {},
): Promise<SampleScreen> {
  const view = await screenView(db, screen);
  const slugs = new Set(trackersOf(view.spec).filter((s) => !s.includes('.')));
  // Una relación apunta a una tabla que la pantalla puede no leer: se necesita su esquema igual.
  const catalog: CatalogTracker[] = [];
  const seen = new Set<string>();
  const queue = [...slugs];
  while (queue.length) {
    const slug = queue.shift() as string;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const t = await getTrackerBySlug(db, slug);
    if (!t) continue;
    catalog.push({ slug: t.slug, name: t.name, fields: t.fields });
  }
  const draft = {
    name: access.app.name,
    description: '',
    icon: access.app.icon,
    roles: access.role.admin
      ? [{ key: 'operario', name: 'Operario', description: '', permissions: { tables: {}, export: false } }]
      : [
          {
            key: access.role.key,
            name: access.role.name,
            description: '',
            permissions: access.role.permissions,
          },
        ],
    screens: [
      {
        title: screen.title,
        slug: screen.slug,
        icon: screen.icon,
        roles: screen.roles,
        spec: view.spec,
      },
    ],
    homeScreen: screen.slug,
    tables: [],
  } as unknown as AppDraft;
  const preview = buildAppPreview(draft, catalog, {
    roleKey: access.role.admin ? null : access.role.key,
    now: options.now,
    filters: options.filters,
    only: [screen.slug],
    record: options.fila
      ? { screen: screen.slug, blockId: options.detail ?? '', rowId: options.fila }
      : null,
  });
  const computed = preview.views[screen.slug];
  if (!computed) throw new NotFoundError('Esa pantalla no existe para este rol.');
  return { computed, samples: preview.samples, notes: preview.notes };
}

/**
 * «Se habría guardado esto»: la fila que un formulario guardaría, en una línea
 * legible («Número: GU-1 · Kilos: 12 · Cliente: Andina»), sólo con lo que trae valor.
 */
export function describeWouldSave(
  fields: readonly Pick<TrackerField, 'key' | 'label' | 'type' | 'percent'>[],
  values: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') continue;
    const shown =
      f.type === 'checkbox'
        ? Number(v) === 1
          ? 'Sí'
          : 'No'
        : displayTrackerValue({ type: f.type, percent: f.percent }, v) || String(v);
    parts.push(`${f.label}: ${shown.length > 60 ? `${shown.slice(0, 59)}…` : shown}`);
  }
  return parts.length ? parts.join(' · ') : 'una fila vacía';
}
