import type { SupabaseClient } from '@supabase/supabase-js';
import { listAccountingConnections } from '../accounting/store';

/**
 * LO QUE SE PUEDE VENDER: el catálogo de productos y servicios del programa
 * contable, como ya llega a las tablas «Productos (Siigo)» / «Productos
 * (Alegra)» (0165). Una línea elegida de aquí lleva la referencia del producto
 * en el programa (el id para Alegra, el código para Siigo), que es lo que hace
 * falta para facturar electrónicamente.
 *
 * Si el inventario propio (0183) llega a tener su tabla de productos, se suma
 * aquí como otra fuente; las líneas siguen guardando `product_ref`/`product_code`.
 */

export interface SellableProduct {
  /** Id del producto en el programa (tracker_rows.external_key). */
  ref: string;
  code: string | null;
  name: string;
  price: number | null;
  unit: string | null;
  kind: string | null;
  provider: 'siigo' | 'alegra';
}

const SELLING_PROVIDERS = new Set(['siigo', 'alegra']);

export async function listSellableProducts(
  db: SupabaseClient,
  opts: { query?: string; limit?: number } = {},
): Promise<SellableProduct[]> {
  const connections = (await listAccountingConnections(db)).filter(
    (c) => SELLING_PROVIDERS.has(c.provider) && c.trackers?.products,
  );
  const out: SellableProduct[] = [];
  for (const conn of connections) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('external_key, values')
      .eq('tracker_id', conn.trackers.products as string)
      .limit(2000);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      external_key: string | null;
      values: Record<string, unknown> | null;
    }>) {
      const v = row.values ?? {};
      if (!row.external_key || v.estado === 'Inactivo') continue;
      const price = Number(v.precio);
      out.push({
        ref: row.external_key,
        code: typeof v.codigo === 'string' && v.codigo.trim() ? v.codigo.trim() : null,
        name: String(v.nombre ?? v.codigo ?? row.external_key).trim(),
        price: Number.isFinite(price) && price > 0 ? price : null,
        unit: typeof v.unidad === 'string' ? v.unidad : null,
        kind: typeof v.tipo === 'string' ? v.tipo : null,
        provider: conn.provider as 'siigo' | 'alegra',
      });
    }
  }
  const query = fold(opts.query ?? '');
  const ranked = query
    ? out
        .map((p) => ({ p, score: matchScore(p, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p)
    : out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return ranked.slice(0, opts.limit ?? 200);
}

/** Sin tildes, minúsculas, espacios simples. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Qué tanto se parece un producto a lo que se escribió: el código exacto gana,
 * después el nombre exacto, después todas las palabras dentro del nombre.
 */
export function matchScore(p: Pick<SellableProduct, 'code' | 'name'>, foldedQuery: string): number {
  if (!foldedQuery) return 0;
  if (p.code && fold(p.code) === foldedQuery) return 100;
  const name = fold(p.name);
  if (name === foldedQuery) return 90;
  const words = foldedQuery.split(' ').filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((w) => name.includes(w)).length;
  return hits === words.length ? 50 + hits : hits >= Math.ceil(words.length / 2) ? hits : 0;
}

/** El producto que corresponde a una línea escrita, sólo si no hay duda. */
export function pickProduct(products: SellableProduct[], text: string): SellableProduct | null {
  const q = fold(text);
  const scored = products
    .map((p) => ({ p, score: matchScore(p, q) }))
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // Dos con el mismo puntaje es una duda: mejor sin producto que con el equivocado.
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) return null;
  return scored[0]?.p ?? null;
}
