import type { GridColumn, GridView } from '@/components/datagrid/types';

/**
 * LAS PREFERENCIAS DE CADA PERSONA SOBRE UNA TABLA.
 *
 * Qué columnas ve, en qué orden, con qué ancho y con qué densidad (cómodo /
 * compacto). Viven en el navegador (una llave por persona y por tabla) y se
 * ponen DEBAJO de la vista del enlace o de una vista guardada: esas mandan. Todo
 * lo que se lee se limpia contra las columnas que existen hoy, así una columna
 * borrada o renombrada no rompe nada.
 */

export type GridDensity = 'comfortable' | 'compact';

export interface GridPrefs {
  hidden?: string[];
  order?: string[];
  widths?: Record<string, number>;
  density?: GridDensity;
}

const PREFIX = 'cortex.grid.v1';

export function prefsStorageKey(userKey: string, gridKey: string): string {
  return `${PREFIX}:${userKey.trim().toLowerCase() || 'anon'}:${gridKey}`;
}

/** Una llave estable por tabla: la ruta sin ids largos + el nombre de lo que lista. */
export function gridKeyFor(pathname: string, noun: string): string {
  const path = pathname
    .split('/')
    .filter(Boolean)
    // Los ids de la ruta (uuid o números largos) no identifican a la tabla.
    .filter((seg) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) && !/^\d{5,}$/.test(seg))
    .join('/');
  return `${path || 'inicio'}#${noun.trim().toLowerCase()}`;
}

export function parsePrefs(raw: string | null | undefined): GridPrefs {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const o = p as Record<string, unknown>;
    const out: GridPrefs = {};
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    const hidden = strings(o.hidden);
    const order = strings(o.order);
    if (hidden) out.hidden = hidden;
    if (order) out.order = order;
    if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
      const widths: Record<string, number> = {};
      for (const [k, w] of Object.entries(o.widths as Record<string, unknown>))
        if (typeof w === 'number' && w >= 48 && w <= 1200) widths[k] = Math.round(w);
      if (Object.keys(widths).length) out.widths = widths;
    }
    if (o.density === 'compact' || o.density === 'comfortable') out.density = o.density;
    return out;
  } catch {
    return {};
  }
}

export function serializePrefs(prefs: GridPrefs): string {
  return JSON.stringify(prefs);
}

/** Lo que de una vista vale la pena recordar. */
export function prefsFromView(
  view: Pick<GridView, 'hidden' | 'order' | 'widths'>,
  density: GridDensity,
): GridPrefs {
  const out: GridPrefs = { hidden: view.hidden, density };
  if (view.order?.length) out.order = view.order;
  if (view.widths && Object.keys(view.widths).length) out.widths = view.widths;
  return out;
}

/** Pone las preferencias sobre una vista, sin tocar filtros ni orden de filas. */
export function applyPrefs(view: GridView, columns: GridColumn[], prefs: GridPrefs): GridView {
  const keys = new Set(columns.map((c) => c.key));
  const pinned = new Set(columns.filter((c) => c.pinned).map((c) => c.key));
  const next: GridView = { ...view };
  if (prefs.hidden) next.hidden = prefs.hidden.filter((k) => keys.has(k) && !pinned.has(k));
  if (prefs.order) next.order = prefs.order.filter((k) => keys.has(k));
  if (prefs.widths) {
    const widths: Record<string, number> = {};
    for (const [k, w] of Object.entries(prefs.widths)) if (keys.has(k)) widths[k] = w;
    next.widths = { ...(view.widths ?? {}), ...widths };
  }
  return next;
}

export function samePrefs(a: GridPrefs, b: GridPrefs): boolean {
  return serializePrefs(a) === serializePrefs(b);
}
