import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug, queryRows } from '../trackers/store';
import { type AppPermissions, USER_ATTRIBUTE_RE, USER_ID_ATTRIBUTE } from './permissions';

/**
 * PORTAL DE CLIENTES: LOS VALORES REALES DE UN ATRIBUTO (fase 4).
 *
 * Un rol «Cliente» lee `{field: 'cliente', equals: '$user.cliente'}`. Al
 * invitar a alguien a ese rol hay que decir de QUÉ cliente es, y escribirlo a
 * mano es la forma de equivocarse («Andina» / «Andina SAS» / «andina»). Aquí
 * salen los valores que de verdad hay en esa columna de esa tabla, para
 * autocompletar al invitar y para «Ver como… cliente X».
 *
 * Es información del propio espacio (quien administra la app ya ve la tabla
 * entera), y sólo la lee el editor: nunca llega a un usuario de la app.
 */

export const MAX_ATTRIBUTE_SUGGESTIONS = 200;
const SCAN_ROWS = 2000;

/** atributo → valores distintos de las columnas que lo usan en algún filtro de rol. */
export async function attributeValueSuggestions(
  db: SupabaseClient,
  roles: Array<{ permissions: AppPermissions }>,
): Promise<Record<string, string[]>> {
  const wanted = new Map<string, Set<string>>();
  for (const role of roles) {
    for (const [tracker, perm] of Object.entries(role.permissions.tables)) {
      if (typeof perm.read !== 'object') continue;
      const attr = USER_ATTRIBUTE_RE.exec(perm.read.equals)?.[1];
      if (!attr || attr === USER_ID_ATTRIBUTE) continue;
      const key = `${tracker}\u0000${perm.read.field}`;
      const set = wanted.get(attr) ?? new Set<string>();
      set.add(key);
      wanted.set(attr, set);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [attr, sources] of wanted) {
    const values = new Set<string>();
    for (const source of sources) {
      const [slug, field] = source.split('\u0000') as [string, string];
      const tracker = await getTrackerBySlug(db, slug);
      if (!tracker) continue;
      const rows = await queryRows(db, { trackerId: tracker.id, limit: SCAN_ROWS });
      for (const row of rows) {
        const v = row.values[field];
        if (typeof v === 'string' || typeof v === 'number') {
          const text = String(v).trim();
          if (text && text.length <= 120) values.add(text);
        }
      }
    }
    out[attr] = [...values]
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
      .slice(0, MAX_ATTRIBUTE_SUGGESTIONS);
  }
  return out;
}
