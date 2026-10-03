'use server';

import type { GridView } from '@/components/datagrid/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { managesTeam } from '@/lib/team/read';

/**
 * LAS VISTAS GUARDADAS DE LA GRILLA (migración 0178, `grid_views`).
 *
 * Tres acciones de servidor que cualquier pantalla con `DataGrid` conecta a
 * `savedViews` / `onSaveView` / `onDeleteView` con su ALCANCE:
 *
 *     const views = await listGridViews('clients');
 *     <DataGrid savedViews={views}
 *       onSaveView={(v) => saveGridView('clients', v)}
 *       onDeleteView={(id) => deleteGridView(id)} … />
 *
 * Alcances: `tracker:<uuid>` para una tabla de la empresa, `clients` para
 * Clientes; cualquier otro `palabra` o `palabra:id` sirve sin migración.
 *
 * QUIÉN. Leer: las compartidas del espacio y las propias. Crear: cualquiera con
 * sesión. Renombrar, cambiar o borrar: quien la creó o quien administra. Cada
 * export vuelve a mirar la sesión: es un endpoint, no una función privada.
 *
 * Errores: lanzan un `Error` con la frase para la persona; la grilla la
 * muestra en un aviso y deshace lo que había hecho por adelantado.
 */

const SCOPE_RE = /^[a-z][a-z_]{1,39}(:[A-Za-z0-9_-]{1,80})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, scope, name, view, created_by, shared, updated_at';
const MAX_VIEWS_PER_SCOPE = 60;

interface Row {
  id: string;
  scope: string;
  name: string;
  view: Record<string, unknown>;
  created_by: string;
  shared: boolean;
  updated_at: string;
}

function checkScope(scope: unknown): string {
  if (typeof scope !== 'string' || !SCOPE_RE.test(scope))
    throw new Error('Esa lista no admite vistas guardadas.');
  return scope;
}

/** Lo que se guarda de una vista: su forma, sin identidad ni permisos. */
function body(view: GridView): Record<string, unknown> {
  const { id: _id, name: _name, shared: _shared, canManage: _canManage, ...rest } = view;
  return {
    search: typeof rest.search === 'string' ? rest.search.slice(0, 200) : '',
    filters: Array.isArray(rest.filters) ? rest.filters.slice(0, 30) : [],
    match: rest.match === 'any' ? 'any' : 'all',
    sort: Array.isArray(rest.sort) ? rest.sort.slice(0, 6) : [],
    groupBy: typeof rest.groupBy === 'string' ? rest.groupBy : null,
    hidden: Array.isArray(rest.hidden) ? rest.hidden.slice(0, 100) : [],
    ...(Array.isArray(rest.order) ? { order: rest.order.slice(0, 100) } : {}),
    ...(rest.widths && typeof rest.widths === 'object' ? { widths: rest.widths } : {}),
    layout: rest.layout ?? 'table',
    layoutKey: typeof rest.layoutKey === 'string' ? rest.layoutKey : null,
    ...(rest.aggregates && typeof rest.aggregates === 'object'
      ? { aggregates: rest.aggregates }
      : {}),
  };
}

function toView(row: Row, canManage: boolean): GridView {
  const v = (row.view ?? {}) as Partial<GridView>;
  return {
    filters: [],
    sort: [],
    hidden: [],
    layout: 'table',
    ...v,
    id: row.id,
    name: row.name,
    shared: row.shared,
    canManage,
  };
}

export async function listGridViews(scope: string): Promise<GridView[]> {
  const s = checkScope(scope);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('grid_views')
    .select(COLUMNS)
    .eq('scope', s)
    .or(`shared.eq.true,created_by.eq.${user.id}`)
    .order('name', { ascending: true })
    .limit(MAX_VIEWS_PER_SCOPE);
  if (error) throw new Error('No se pudieron leer las vistas guardadas.');
  const admin = managesTeam(user);
  return ((data ?? []) as Row[]).map((r) => toView(r, admin || r.created_by === user.id));
}

export async function saveGridView(scope: string, view: GridView): Promise<GridView> {
  const s = checkScope(scope);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const name = (typeof view?.name === 'string' ? view.name.trim() : '').slice(0, 80);
  if (!name) throw new Error('Ponle un nombre a la vista.');
  const payload = body(view);
  if (JSON.stringify(payload).length > 12_000) throw new Error('Esa vista es demasiado grande.');
  const admin = managesTeam(user);

  if (view.id) {
    if (!UUID_RE.test(view.id)) throw new Error('Esa vista ya no existe.');
    const { data: found, error: readError } = await db
      .from('grid_views')
      .select(COLUMNS)
      .eq('id', view.id)
      .eq('scope', s)
      .maybeSingle();
    if (readError) throw new Error('No se pudo leer la vista.');
    const current = found as Row | null;
    if (!current || (!current.shared && current.created_by !== user.id))
      throw new Error('Esa vista ya no existe.');
    if (!admin && current.created_by !== user.id)
      throw new Error('Solo quien creó la vista, o quien administra, la puede cambiar.');
    const { data, error } = await db
      .from('grid_views')
      .update({
        name,
        view: payload,
        shared: typeof view.shared === 'boolean' ? view.shared : current.shared,
        updated_at: new Date().toISOString(),
      })
      .eq('id', current.id)
      .select(COLUMNS)
      .single();
    if (error) throw new Error('No se pudo guardar la vista.');
    return toView(data as Row, true);
  }

  const { count, error: countError } = await db
    .from('grid_views')
    .select('id', { count: 'exact', head: true })
    .eq('scope', s)
    .eq('created_by', user.id);
  if (countError) throw new Error('No se pudo guardar la vista.');
  if ((count ?? 0) >= MAX_VIEWS_PER_SCOPE)
    throw new Error(`Tienes ${MAX_VIEWS_PER_SCOPE} vistas en esta lista; borra alguna primero.`);
  const { data, error } = await db
    .from('grid_views')
    .insert({ scope: s, name, view: payload, created_by: user.id, shared: Boolean(view.shared) })
    .select(COLUMNS)
    .single();
  if (error) throw new Error('No se pudo guardar la vista.');
  return toView(data as Row, true);
}

export async function deleteGridView(id: string): Promise<void> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Esa vista ya no existe.');
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error: readError } = await db
    .from('grid_views')
    .select('id, created_by, shared')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw new Error('No se pudo leer la vista.');
  const row = data as { id: string; created_by: string; shared: boolean } | null;
  if (!row || (!row.shared && row.created_by !== user.id)) return;
  if (row.created_by !== user.id && !managesTeam(user))
    throw new Error('Solo quien creó la vista, o quien administra, la puede borrar.');
  const { error } = await db.from('grid_views').delete().eq('id', row.id);
  if (error) throw new Error('No se pudo borrar la vista.');
}
