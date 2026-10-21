import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ¿QUÉ PANTALLAS SE ROMPEN SI QUITO ESTE CAMPO?
 *
 * Recorre las vistas vivas del espacio y, de cada bloque que lee la tabla,
 * junta las llaves pedidas que aparecen en cualquier parte del bloque
 * (columnas, filtros, formularios, gráficos…). Es genérico: no conoce los tipos
 * de bloque, sólo busca la llave como valor de texto dentro de uno que nombra
 * la tabla. Sirve para avisar ANTES de quitar el campo; la lectura nunca falla
 * la operación (si algo sale mal, devuelve lo que alcanzó a ver).
 */

export interface FieldUse {
  viewId: string;
  viewTitle: string;
  /** Las pantallas de aplicaciones que muestran esta vista. */
  screens: Array<{ appName: string; screenTitle: string }>;
  blocks: Array<{ id: string; title: string; fields: string[] }>;
}

function leafStrings(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === 'string') {
    out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) leafStrings(v, out, depth + 1);
    return;
  }
  if (typeof node === 'object')
    for (const v of Object.values(node as Record<string, unknown>)) leafStrings(v, out, depth + 1);
}

function namesTracker(node: unknown, slug: string, depth = 0): boolean {
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((v) => namesTracker(v, slug, depth + 1));
  const rec = node as Record<string, unknown>;
  if (rec.tracker === slug || rec.table === slug) return true;
  return Object.values(rec).some((v) => namesTracker(v, slug, depth + 1));
}

/** Puro: las vistas ya leídas → los usos. Separado para probarlo sin base. */
export function fieldUsesInSpecs(
  views: Array<{ id: string; title: string; spec: unknown }>,
  slug: string,
  keys: readonly string[],
): FieldUse[] {
  const wanted = new Set(keys);
  const uses: FieldUse[] = [];
  for (const view of views) {
    const blocks = (view.spec as { blocks?: unknown } | null)?.blocks;
    if (!Array.isArray(blocks)) continue;
    const hit: FieldUse['blocks'] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || !namesTracker(block, slug)) continue;
      const strings = new Set<string>();
      leafStrings(block, strings);
      const fields = [...wanted].filter((k) => strings.has(k));
      if (!fields.length) continue;
      const b = block as { id?: unknown; title?: unknown; type?: unknown };
      hit.push({
        id: String(b.id ?? ''),
        title: typeof b.title === 'string' && b.title ? b.title : String(b.type ?? 'bloque'),
        fields,
      });
    }
    if (hit.length) uses.push({ viewId: view.id, viewTitle: view.title, screens: [], blocks: hit });
  }
  return uses;
}

export async function findFieldUses(
  db: SupabaseClient,
  slug: string,
  keys: readonly string[],
): Promise<FieldUse[]> {
  if (!keys.length) return [];
  try {
    const { data } = await db
      .from('custom_views')
      .select('id,title,spec')
      .is('archived_at', null)
      .limit(500);
    const uses = fieldUsesInSpecs(
      (data ?? []) as Array<{ id: string; title: string; spec: unknown }>,
      slug,
      keys,
    );
    if (!uses.length) return uses;
    const { data: screens } = await db
      .from('custom_app_screens')
      .select('view_id,title,custom_apps(name)')
      .in(
        'view_id',
        uses.map((u) => u.viewId),
      );
    for (const s of (screens ?? []) as unknown as Array<{
      view_id: string;
      title: string;
      custom_apps: { name: string } | Array<{ name: string }> | null;
    }>) {
      const app = Array.isArray(s.custom_apps) ? s.custom_apps[0] : s.custom_apps;
      uses
        .find((u) => u.viewId === s.view_id)
        ?.screens.push({ appName: app?.name ?? 'una aplicación', screenTitle: s.title });
    }
    return uses;
  } catch {
    return [];
  }
}

/** «Se rompen: Detalle de vuelo (Control de vuelos) — campos estado, hora_real». */
export function fieldUsesSentence(uses: FieldUse[]): string {
  return uses
    .map((u) => {
      const where = u.screens.length
        ? ` (${u.screens.map((s) => `${s.appName} › ${s.screenTitle}`).join(', ')})`
        : '';
      const fields = [...new Set(u.blocks.flatMap((b) => b.fields))].join(', ');
      return `«${u.viewTitle}»${where}: ${fields}`;
    })
    .join('; ');
}

/** Cuántas filas guardan valor en cada campo (por si se quita: los valores quedan pero ya no se ven). */
export async function countFieldValues(
  db: SupabaseClient,
  trackerId: string,
  keys: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  if (!keys.length) return out;
  try {
    const { data } = await db
      .from('tracker_rows')
      .select('values')
      .eq('tracker_id', trackerId)
      .limit(5000);
    for (const row of (data ?? []) as Array<{ values: Record<string, unknown> | null }>)
      for (const k of keys) {
        const v = row.values?.[k];
        if (v !== undefined && v !== null && v !== '') out[k] = (out[k] ?? 0) + 1;
      }
  } catch {
    /* sin conteo: la tarjeta lo dice sin número */
  }
  return out;
}
