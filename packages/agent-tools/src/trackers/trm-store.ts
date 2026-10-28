import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TRM_SOURCE_URL,
  type TrmRate,
  ambientTrm,
  ambientTrmAge,
  normalizeTrm,
  parseSocrataTrm,
  setAmbientTrm,
} from './trm';

/**
 * La TRM oficial en la base (migración 0241): leer, cargar en memoria para las
 * fórmulas y traer lo nuevo de datos.gov.co. Servidor.
 */

const TABLE = 'platform_trm_rates';
const PAGE = 1000;
/** Cuánto vale la copia en memoria antes de releerla de la base. */
const AMBIENT_TTL_MS = 6 * 3_600_000;

export async function loadTrm(db: SupabaseClient): Promise<TrmRate[]> {
  const out: TrmRate[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE)
      .select('vigencia_desde, vigencia_hasta, valor')
      .order('vigencia_desde', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      vigencia_desde: string;
      vigencia_hasta: string;
      valor: number | string;
    }>;
    for (const r of rows)
      out.push({ from: r.vigencia_desde, to: r.vigencia_hasta, value: Number(r.valor) });
    if (rows.length < PAGE) break;
  }
  return normalizeTrm(out);
}

/** Deja la TRM lista en memoria para `trm()`. Nunca lanza: sin TRM la fórmula avisa y queda vacía. */
export async function ensureTrm(db: SupabaseClient): Promise<void> {
  if (ambientTrm().length && ambientTrmAge() < AMBIENT_TTL_MS) return;
  try {
    setAmbientTrm(await loadTrm(db));
  } catch {
    // Migración sin aplicar o base sin respuesta: se sigue sin TRM.
  }
}

export interface TrmSyncResult {
  fetched: number;
  stored: number;
  latest: string | null;
}

/**
 * Trae de datos.gov.co las vigencias que faltan. Sin histórico en la base trae
 * todo (por páginas); con histórico, sólo lo posterior a hace un mes (por si
 * Superfinanciera corrige) — idempotente: es un upsert por `vigencia_desde`.
 */
export async function syncTrm(
  db: SupabaseClient,
  opts: { fetchImpl?: typeof fetch; full?: boolean } = {},
): Promise<TrmSyncResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const { data: last } = await db
    .from(TABLE)
    .select('vigencia_desde')
    .order('vigencia_desde', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastDay = (last as { vigencia_desde?: string } | null)?.vigencia_desde ?? null;
  let since: string | null = null;
  if (lastDay && !opts.full) {
    const d = new Date(`${lastDay}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 31);
    since = d.toISOString().slice(0, 10);
  }
  let fetched = 0;
  let stored = 0;
  for (let offset = 0; offset < 200_000; offset += 5000) {
    const url = new URL(TRM_SOURCE_URL);
    url.searchParams.set('$limit', '5000');
    url.searchParams.set('$offset', String(offset));
    url.searchParams.set('$order', 'vigenciadesde');
    if (since) url.searchParams.set('$where', `vigenciadesde >= '${since}T00:00:00'`);
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`datos.gov.co respondió ${res.status}`);
    const rates = parseSocrataTrm(await res.json());
    fetched += rates.length;
    for (let i = 0; i < rates.length; i += 500) {
      const chunk = rates.slice(i, i + 500).map((r) => ({
        vigencia_desde: r.from,
        vigencia_hasta: r.to,
        valor: r.value,
        fetched_at: new Date().toISOString(),
      }));
      const { error } = await db.from(TABLE).upsert(chunk, { onConflict: 'vigencia_desde' });
      if (error) throw error;
      stored += chunk.length;
    }
    if (rates.length < 5000) break;
  }
  if (stored) setAmbientTrm(await loadTrm(db));
  const table = ambientTrm();
  return { fetched, stored, latest: table.length ? (table[table.length - 1] as TrmRate).to : null };
}
