import 'server-only';

import { bogotaDay } from '@cortex/agent-tools/src/format/display';
import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import { readCartera } from '@cortex/agent-tools/src/payments/cartera-read';
import { readDefaultTermDays } from '@cortex/agent-tools/src/payments/terms';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type DianInvoiceRow,
  type FlightRow,
  type HoyInsights,
  type StatementRow,
  buildDian,
  buildFlow,
  buildOperation,
  buildReceivable,
  buildResult,
  buildWeekCards,
} from './insights';

/**
 * LO QUE «HOY» LEE ADEMÁS DE LA CAJA: la cartera con el plazo por defecto de la
 * empresa, los estados de resultados y las facturas de Siigo (sus tablas
 * sincronizadas) y las tablas de la operación (vuelos, prealertas). Cada
 * lectura va en su propio try: la que falle deja su bloque sin pintar y la
 * página sigue. Sólo lee.
 */

const PAGE = 1000;
const MAX_ROWS = 6000;

type Row = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: un filtro de PostgREST encadenable, sin tipo público estable
type Apply = (q: any) => any;

async function safe<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

async function trackerId(db: SupabaseClient, slug: string): Promise<string | null> {
  const { data } = await db.from('trackers').select('id').eq('slug', slug).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/** Las filas de una tabla por su nombre corto; `null` si la tabla no existe. */
async function trackerRows(
  db: SupabaseClient,
  slug: string,
  apply: Apply = (q) => q,
): Promise<Array<{ values: Row; createdAt: string }> | null> {
  const id = await trackerId(db, slug);
  if (!id) return null;
  const out: Array<{ values: Row; createdAt: string }> = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await apply(
      db.from('tracker_rows').select('values, created_at').eq('tracker_id', id),
    ).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ values?: Row; created_at?: string }>;
    for (const r of rows)
      out.push({ values: r.values ?? {}, createdAt: String(r.created_at ?? '') });
    if (rows.length < PAGE) break;
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface ReadInsightsInput {
  db: SupabaseClient;
  today: string;
  isAdmin: boolean;
  financeOn: boolean;
  currency: string;
  /** Lo que ya leyó la plata de «Hoy». `null` = módulo apagado o sin datos. */
  money: {
    movements: LedgerMovement[];
    forecast: ForecastResult | null;
    minimumCash: number | null;
  } | null;
}

export async function readInsights(input: ReadInsightsInput): Promise<HoyInsights> {
  const { db, today, isAdmin, financeOn } = input;
  const currency = input.currency;

  const [term, statements, invoices, flights, prealerts] = await Promise.all([
    financeOn ? safe(() => readDefaultTermDays(db)) : Promise.resolve(null),
    // Los estados son cifras de toda la empresa, incluida la nómina sumada: sólo quien administra.
    financeOn && isAdmin
      ? safe(() =>
          trackerRows(db, 'siigo_estados_financieros', (q) =>
            q.eq('values->>estado', 'Estado de resultados').eq('values->>seccion', 'Resumen'),
          ),
        )
      : Promise.resolve(null),
    financeOn ? safe(() => trackerRows(db, 'siigo_facturas')) : Promise.resolve(null),
    safe(() => trackerRows(db, 'vuelos')),
    safe(() => trackerRows(db, 'prealertas')),
  ]);
  const cartera = financeOn
    ? await safe(() => readCartera(db, { today, defaultTermDays: term }))
    : null;

  const dian = invoices
    ? buildDian(
        invoices.map<DianInvoiceRow>(({ values: v }) => ({
          numero: str(v.numero),
          cliente: str(v.cliente),
          total: num(v.total),
          fecha: str(v.fecha),
          estado: str(v.estado),
          factura_electronica: str(v.factura_electronica),
          mensaje_dian: str(v.mensaje_dian) || null,
          enlace: str(v.enlace) || null,
        })),
        { currency },
      )
    : null;

  const result = statements
    ? buildResult(
        statements.map<StatementRow>(({ values: v }) => ({
          periodo: str(v.periodo),
          estado: str(v.estado),
          seccion: str(v.seccion),
          renglon: str(v.renglon),
          valor: num(v.valor),
          en_curso: str(v.en_curso) || null,
        })),
        today,
        currency,
      )
    : null;

  const operation = buildOperation({
    today,
    flights: flights
      ? flights.map<FlightRow>(({ values: v }) => ({
          fecha: str(v.fecha),
          estado: str(v.estado),
          aerolinea: str(v.aerolinea),
          numero_vuelo: str(v.numero_vuelo),
        }))
      : null,
    prealertDays: prealerts
      ? prealerts.filter((r) => r.createdAt).map((r) => bogotaDay(new Date(r.createdAt)))
      : null,
  });

  return {
    currency,
    week: buildWeekCards({
      today,
      currency,
      cartera,
      defaultTermDays: term,
      movements: input.money?.movements ?? null,
      isAdmin,
      dian,
    }),
    flow: input.money?.forecast ? buildFlow(input.money.forecast, input.money.minimumCash) : null,
    result,
    receivable: cartera ? buildReceivable(cartera) : null,
    dian,
    operation,
  };
}
