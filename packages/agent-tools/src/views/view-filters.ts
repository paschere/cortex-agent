import type { FilterBarItem, ViewSpec } from './spec';

/**
 * LO QUE LA BARRA DE FILTROS MANDA, VALIDADO CONTRA EL SPEC.
 *
 * La barra (`spec.filtersBar`) vive arriba de la vista; lo que alguien elige
 * viaja en UN parámetro, `f`, para que la dirección se pueda copiar y una
 * vista filtrada se comparta tal cual:
 *
 *   ?f=sede%3DBogot%C3%A1%26fechas%3D2026-09-01~2026-09-30%26q%3Dacme
 *
 * es decir, `f` = una cadena `id=valor&id=valor` (la misma forma de una query,
 * codificada otra vez). Rango de fechas: `desde~hasta`, cualquiera de los dos
 * puede faltar.
 *
 * El servidor NO confía en el parámetro: `parseViewFilterParam` sólo acepta
 * ids que el spec guardado declara, valores cortos y fechas AAAA-MM-DD. Un
 * valor raro no rompe nada —se compara por igualdad o se busca como texto—,
 * pero tampoco se le deja crecer. Lo que no cuadra se descarta en silencio:
 * un enlace viejo con un filtro que ya no existe abre la vista sin ese filtro.
 *
 * Sin dependencias de la base ni de React: lo usan las rutas de datos, la
 * página pública y las pruebas.
 */

export type FilterBarValue =
  | { kind: 'select'; value: string }
  | { kind: 'search'; value: string }
  | { kind: 'date_range'; from: string | null; to: string | null };

export type ViewFilterState = Record<string, FilterBarValue>;

/** Tope del parámetro entero: seis filtros con valores cortos caben de sobra. */
export const MAX_FILTER_PARAM = 1500;
const MAX_VALUE = 120;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(v: string): string | null {
  if (!ISO_DAY.test(v)) return null;
  const t = Date.parse(`${v}T12:00:00Z`);
  return Number.isNaN(t) ? null : v;
}

function parseOne(item: FilterBarItem, raw: string): FilterBarValue | null {
  const value = raw.trim();
  if (!value || value.length > MAX_VALUE) return null;
  if (item.kind === 'date_range') {
    const [a = '', b = ''] = value.split('~');
    const from = a ? validDay(a) : null;
    const to = b ? validDay(b) : null;
    if ((a && !from) || (b && !to) || (!from && !to)) return null;
    // Al revés también vale: se ordena.
    return from && to && from > to
      ? { kind: 'date_range', from: to, to: from }
      : { kind: 'date_range', from, to };
  }
  if (item.kind === 'search') return { kind: 'search', value: value.slice(0, 80) };
  return { kind: 'select', value };
}

/** El parámetro `f` (ya decodificado una vez por la URL) → la elección válida. */
export function parseViewFilterParam(
  spec: Pick<ViewSpec, 'filtersBar'>,
  raw: string | null | undefined,
): ViewFilterState {
  const state: ViewFilterState = {};
  const bar = spec.filtersBar ?? [];
  if (!raw || !bar.length || raw.length > MAX_FILTER_PARAM) return state;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return state;
  }
  for (const item of bar) {
    const value = params.get(item.id);
    if (value === null) continue;
    const parsed = parseOne(item, value);
    if (parsed) state[item.id] = parsed;
  }
  return state;
}

/** La elección → el valor de `f`. Lo usa el navegador para escribir la URL. */
export function encodeViewFilterState(state: ViewFilterState): string {
  const params = new URLSearchParams();
  for (const [id, v] of Object.entries(state)) {
    if (v.kind === 'date_range') {
      if (v.from || v.to) params.set(id, `${v.from ?? ''}~${v.to ?? ''}`);
    } else if (v.value.trim()) params.set(id, v.value.trim());
  }
  return params.toString();
}
