import type {
  GridAggregate,
  GridColumn,
  GridFilter,
  GridFilterOp,
  GridLayout,
  GridView,
} from '@/components/datagrid/types';
import { normalizeView } from './view';

/**
 * UNA VISTA EN UN ENLACE: `?vista=…`.
 *
 * Quien filtra «guías en novedad de esta semana» y copia la URL tiene que
 * mandar exactamente eso. La vista viaja compacta (claves de una letra, solo
 * lo que difiere de la vista vacía) en JSON y base64url, que pasa por correo,
 * WhatsApp y Slack sin que nadie la rompa.
 *
 * Leer nunca lanza: un enlace viejo, cortado o manipulado da `null` y la
 * grilla abre con su vista por defecto. Lo que se lee pasa por
 * `normalizeView`, así que una columna que ya no existe simplemente se cae.
 */

export const VIEW_PARAM = 'vista';

type Compact = {
  v: 1;
  id?: string;
  n?: string;
  q?: string;
  f?: Array<[string, GridFilterOp, unknown] | [string, GridFilterOp]>;
  m?: 'any';
  s?: Array<[string, 'a' | 'd']>;
  g?: string;
  h?: string[];
  o?: string[];
  w?: Record<string, number>;
  l?: GridLayout;
  k?: string;
  a?: Record<string, GridAggregate>;
};

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function compactView(view: Partial<GridView>): Compact {
  const c: Compact = { v: 1 };
  if (view.id) c.id = view.id;
  if (view.name) c.n = view.name;
  if (view.search?.trim()) c.q = view.search.trim();
  if (view.filters?.length)
    c.f = view.filters.map((f) => (f.value === undefined ? [f.key, f.op] : [f.key, f.op, f.value]));
  if (view.match === 'any') c.m = 'any';
  if (view.sort?.length) c.s = view.sort.map((s) => [s.key, s.dir === 'desc' ? 'd' : 'a']);
  if (view.groupBy) c.g = view.groupBy;
  if (view.hidden?.length) c.h = view.hidden;
  if (view.order?.length) c.o = view.order;
  if (view.widths && Object.keys(view.widths).length) c.w = view.widths;
  if (view.layout && view.layout !== 'table') c.l = view.layout;
  if (view.layoutKey) c.k = view.layoutKey;
  if (view.aggregates && Object.keys(view.aggregates).length) c.a = view.aggregates;
  return c;
}

export function expandView(c: Compact): Partial<GridView> {
  const filters: GridFilter[] = (Array.isArray(c.f) ? c.f : []).flatMap((f) => {
    if (!Array.isArray(f) || typeof f[0] !== 'string' || typeof f[1] !== 'string') return [];
    return [f.length > 2 ? { key: f[0], op: f[1], value: f[2] } : { key: f[0], op: f[1] }];
  });
  return {
    ...(typeof c.id === 'string' ? { id: c.id } : {}),
    ...(typeof c.n === 'string' ? { name: c.n } : {}),
    search: typeof c.q === 'string' ? c.q : '',
    filters,
    match: c.m === 'any' ? 'any' : 'all',
    sort: (Array.isArray(c.s) ? c.s : [])
      .filter((s) => Array.isArray(s) && typeof s[0] === 'string')
      .map((s) => ({ key: s[0], dir: s[1] === 'd' ? 'desc' : 'asc' })),
    groupBy: typeof c.g === 'string' ? c.g : null,
    hidden: Array.isArray(c.h) ? c.h.filter((k) => typeof k === 'string') : [],
    ...(Array.isArray(c.o) ? { order: c.o.filter((k) => typeof k === 'string') } : {}),
    ...(c.w && typeof c.w === 'object' ? { widths: c.w } : {}),
    layout: c.l ?? 'table',
    layoutKey: typeof c.k === 'string' ? c.k : null,
    ...(c.a && typeof c.a === 'object' ? { aggregates: c.a } : {}),
  };
}

/** La vista como texto para `?vista=`. Vacío si no hay nada que decir. */
export function encodeView(view: Partial<GridView>): string {
  const c = compactView(view);
  if (Object.keys(c).length === 1) return '';
  return toBase64Url(JSON.stringify(c));
}

/** El texto de `?vista=` → vista normalizada contra estas columnas, o `null`. */
export function decodeView(
  param: string | null | undefined,
  columns: GridColumn[],
): GridView | null {
  if (!param || param.length > 8000) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(param)) as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as Compact).v !== 1) return null;
    return normalizeView(columns, expandView(parsed as Compact));
  } catch {
    return null;
  }
}

/** La misma búsqueda con la vista puesta (o quitada), sin tocar lo demás. */
export function searchWithView(
  search: string,
  view: Partial<GridView> | null,
  param = VIEW_PARAM,
): string {
  const params = new URLSearchParams(search);
  const encoded = view ? encodeView(view) : '';
  if (encoded) params.set(param, encoded);
  else params.delete(param);
  const s = params.toString();
  return s ? `?${s}` : '';
}
