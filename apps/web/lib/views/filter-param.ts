import type { FilterBarValue } from '@cortex/agent-tools';

/**
 * EL PARÁMETRO `?f=` DE LA BARRA DE FILTROS, DEL LADO DEL NAVEGADOR.
 *
 * Copia de `encodeViewFilterState` (packages/agent-tools/src/views/
 * view-filters.ts) por la misma razón que editor-shape.ts: el barril del
 * paquete no entra al bundle de cliente. `filter-param.test.ts` comprueba que
 * lo que se escribe aquí es lo que el servidor lee allá.
 *
 * El navegador sólo ESCRIBE la elección; quien la valida es el servidor
 * (`parseViewFilterParam`), que descarta lo que el spec no declara.
 */

export type FilterState = Record<string, FilterBarValue>;

export function encodeFilterState(state: FilterState): string {
  const params = new URLSearchParams();
  for (const [id, v] of Object.entries(state)) {
    if (v.kind === 'date_range') {
      if (v.from || v.to) params.set(id, `${v.from ?? ''}~${v.to ?? ''}`);
    } else if (v.value.trim()) params.set(id, v.value.trim());
  }
  return params.toString();
}

/** Lo elegido que vino con la vista (el servidor ya lo validó) → estado. */
export function stateFromComputed(
  items: Array<{ id: string; value: FilterBarValue | null }> | undefined,
): FilterState {
  const out: FilterState = {};
  for (const item of items ?? []) if (item.value) out[item.id] = item.value;
  return out;
}

/** La dirección de datos con `f` (o sin él, si no hay nada elegido). */
export function withFilterParam(dataUrl: string, f: string, origin: string): string {
  const url = new URL(dataUrl, origin);
  if (f) url.searchParams.set('f', f);
  else url.searchParams.delete('f');
  return `${url.pathname}${url.search}`;
}
