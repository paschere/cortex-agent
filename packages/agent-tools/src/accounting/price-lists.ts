import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../trackers/store';
import { accountingTableSlug } from './tables';

/**
 * PRECIOS POR LISTA, PARA LAS PREFACTURAS (0235). Lee la tabla sincronizada
 * «Precios por lista» (siigo_precios_productos). La lista se nombra por su
 * nombre («Mayorista») o por su posición («2»); sin distinguir mayúsculas.
 */

export type ListPriceLookup = (productCode: string, list: string) => number | undefined;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

export function buildListPriceLookup(
  rows: ReadonlyArray<{ codigo?: unknown; lista?: unknown; posicion?: unknown; precio?: unknown }>,
): ListPriceLookup {
  const map = new Map<string, number>();
  for (const r of rows) {
    const code = norm(String(r.codigo ?? ''));
    const price = Number(r.precio);
    if (!code || !Number.isFinite(price)) continue;
    if (r.lista) map.set(`${code}|${norm(String(r.lista))}`, price);
    if (r.posicion !== undefined && r.posicion !== null && r.posicion !== '')
      map.set(`${code}|${norm(String(r.posicion))}`, price);
  }
  return (code, list) => map.get(`${norm(code)}|${norm(list)}`);
}

/** Carga los precios de los productos pedidos (por código). Sin tabla, ninguno. */
export async function loadListPrices(
  db: SupabaseClient,
  codes: readonly string[],
  provider = 'siigo',
): Promise<ListPriceLookup> {
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (!unique.length) return () => undefined;
  const tracker = await getTrackerBySlug(db, accountingTableSlug(provider, 'product_prices'));
  if (!tracker) return () => undefined;
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unique.length; i += 40) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('values')
      .eq('tracker_id', tracker.id)
      .in('values->>codigo', unique.slice(i, i + 40))
      .limit(1000);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ values: Record<string, unknown> }>) rows.push(r.values);
  }
  return buildListPriceLookup(rows);
}
