import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Una base en memoria para las pruebas de las fuentes contables: cada método
 * encadenado de PostgREST devuelve el mismo objeto y sólo `eq`, `in`, `range`,
 * `maybeSingle`, `single` y `upsert` filtran o escriben. Sólo lo usan pruebas.
 */

export type FakeRow = Record<string, unknown>;

export function fakeDb(
  tables: Record<string, FakeRow[]>,
  errors: Record<string, { code: string; message: string }> = {},
): SupabaseClient {
  const from = (name: string) => {
    let rows = [...(tables[name] ?? [])];
    let range: [number, number] | null = null;
    let single = false;
    const api: Record<string, unknown> = {};
    const chain = () => api;
    for (const m of [
      'select',
      'order',
      'limit',
      'like',
      'not',
      'is',
      'gte',
      'lte',
      'neq',
      'or',
      'contains',
      'ilike',
    ])
      api[m] = chain;
    api.eq = (k: string, v: unknown) => {
      rows = rows.filter((r) => r[k] === v);
      return api;
    };
    api.in = (k: string, vs: unknown[]) => {
      rows = rows.filter((r) => vs.includes(r[k]));
      return api;
    };
    api.range = (a: number, b: number) => {
      range = [a, b];
      return api;
    };
    api.maybeSingle = () => {
      single = true;
      return api;
    };
    api.single = api.maybeSingle;
    api.upsert = (row: FakeRow) => {
      const list = tables[name] ?? [];
      tables[name] = list;
      const at = list.findIndex((r) => r.tracker_id === row.tracker_id && r.kind === row.kind);
      const merged = { id: `src-${list.length + 1}`, created_at: 't', ...(list[at] ?? {}), ...row };
      if (at >= 0) list[at] = merged;
      else list.push(merged);
      rows = [merged];
      return api;
    };
    // PostgREST se espera con await: el objeto es «thenable» a propósito.
    // biome-ignore lint/suspicious/noThenProperty: imita al constructor de consultas de Supabase
    api.then = (res: (v: unknown) => unknown) => {
      const out = range ? rows.slice(range[0], range[1] + 1) : rows;
      const error = errors[name] ?? null;
      return Promise.resolve(res({ data: error ? null : single ? (out[0] ?? null) : out, error }));
    };
    return api;
  };
  return { from } as unknown as SupabaseClient;
}
