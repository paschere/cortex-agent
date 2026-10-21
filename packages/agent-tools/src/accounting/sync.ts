import type { SupabaseClient } from '@supabase/supabase-js';
import { emitSyncEvents } from '../apps/automations/emit';
import { bogotaToday } from '../commitments/shape';
import { importSystemPayments } from '../payments/import';
import { type TrackerField, rowLabel, trackerFieldsSchema } from '../trackers/schema';
import {
  type TrackerRow,
  defineTracker,
  getTrackerById,
  getTrackerBySlug,
  markForReview,
  setTrackerOrigin,
  shapeValuesDetailed,
} from '../trackers/store';
import {
  PARTY_HISTORY_MONTHS,
  derivedMonthQueries,
  isMonthlyDerived,
  readPartyBalanceMonth,
  readStatementMonth,
  recordsForMonth,
  stockLinesFromProduct,
} from './derived';
import { partyBalanceLines, productPriceLines } from './providers/siigo-more';
import { getAccountingProvider } from './providers';
import type { NormalizedPurchase } from './providers/purchases';
import type {
  AccountingConnectionRow,
  EntityCounts,
  EntityCursor,
  RunCounts,
  RunResult,
} from './store';
import {
  type AccountingInvoiceInput,
  type AccountingTableSpec,
  accountingTableSpec,
  paymentRowsFor,
  productPriceValues,
  accountPayableState,
  receivableFor,
  stockValues,
  valuesFor,
} from './tables';
import type {
  AccountingEntity,
  AccountingProvider,
  NormalizedCreditNote,
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedJournalLine,
  NormalizedProduct,
  NormalizedQuotation,
  NormalizedRecord,
  NormalizedSupplierPayment,
  ProviderSession,
} from './types';
import { ACCOUNTING_ENTITIES, CATALOG_ENTITIES } from './types';

/**
 * EL MOTOR: TRAER DE UN PROGRAMA CONTABLE A LAS TABLAS Y A LA CARTERA (0165).
 *
 * Una corrida, por cada cosa elegida y en este orden —clientes primero, para
 * que las facturas y los pagos salgan con el nombre del cliente—:
 *
 *   1. Decide qué pedir (`planEntity`): la primera vez, el historial que permita
 *      el programa (Siigo completo); después,
 *      lo creado o cambiado desde la corrida anterior, con diez minutos de
 *      margen; y una vez al día, además, las facturas recientes, porque un abono
 *      no siempre marca la factura como modificada.
 *   2. Pide página por página y escribe cada una ANTES de pedir la siguiente.
 *      Si se acaba el tiempo, anota dónde iba (`resume`) y la próxima corrida
 *      —un minuto después— sigue de ahí. La primera carga de una empresa grande
 *      son varias corridas, no una que se cae a la mitad.
 *   3. Cada registro es una fila identificada por el id del programa
 *      (`tracker_rows.external_key`): nuevo se agrega, cambiado se actualiza,
 *      igual no se toca. Los campos que el equipo le agregó a la tabla («notas»,
 *      «responsable») no se pisan: sólo se escriben los del programa.
 *   4. Las facturas además se escriben en `accounting_invoices` (la cartera);
 *      los pagos, en Pagos por el importador de sistema. Las dos cosas son
 *      idempotentes: traer dos veces lo mismo no mueve ni un peso.
 *
 * El motor no sabe de Siigo: habla con `ProviderSession` (providers/*), que ya
 * devuelve la forma común. Tampoco marca la corrida ni suena la campana: eso
 * es del trabajo programado (apps/web/inngest/functions/accounting-sync.ts).
 */

/** Margen hacia atrás de cada lectura incremental: un reloj corrido no pierde nada. */
const OVERLAP_MS = 10 * 60_000;
/** Cada cuánto se repasan las facturas recientes. */
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** Tope de páginas por cosa y corrida (100 registros cada una). */
const MAX_PAGES_PER_RUN = 500;
const CHUNK = 200;

const ENTITY_LABEL: Record<AccountingEntity, string> = {
  customers: 'clientes',
  products: 'productos',
  invoices: 'facturas',
  payments: 'recibos de caja',
  credit_notes: 'notas crédito',
  purchases: 'compras',
  supplier_payments: 'pagos a proveedores',
  journal_lines: 'movimientos contables',
  quotations: 'cotizaciones',
  stock: 'existencias',
  statements: 'estados financieros',
  payroll_costs: 'costo de nómina',
  cost_centers: 'centros de costo',
  taxes: 'impuestos',
  payment_methods: 'formas de pago',
  warehouses: 'bodegas',
  document_types: 'tipos de documento',
  sellers: 'vendedores',
  accounts_payable: 'cuentas por pagar (reporte oficial)',
  party_balances: 'saldos por tercero',
  product_prices: 'precios por lista',
  fixed_assets: 'activos fijos',
  price_lists: 'listas de precios',
  account_groups: 'grupos de inventario',
  expense_concepts: 'conceptos de descuento',
  cities: 'ciudades',
};

/** Los catálogos y los estados mensuales se revisan una vez al día, no cada 15 minutos. */
const DAILY_ENTITIES = new Set<AccountingEntity>([
  ...CATALOG_ENTITIES,
  'statements',
  'payroll_costs',
  'party_balances',
  'accounts_payable',
]);
/**
 * Lo que el programa puede no exponer (endpoints sin documentar o que depende
 * del plan): si responde «no existe» o «no permitido», no es una falla de la
 * sincronización sino una nota; el resto sigue.
 */
const OPTIONAL_ENTITIES = new Set<AccountingEntity>([
  'cities',
  'expense_concepts',
  'fixed_assets',
  'price_lists',
  'account_groups',
  'accounts_payable',
  'party_balances',
]);
/** Los que se repasan cada día por lo que cambia sin «modificar» el documento (saldos). */
const SWEEP_ENTITIES = new Set<AccountingEntity>([
  'invoices',
  'payments',
  'purchases',
  'supplier_payments',
]);
/** Los que se comparan con el total que dice el programa. */
const AUDITED_ENTITIES = new Set<AccountingEntity>([
  'invoices',
  'payments',
  'credit_notes',
  'purchases',
  'quotations',
]);
/** Se arman de otras lecturas: no cuentan para «terminó la primera carga». */
const SOFT_ENTITIES = new Set<AccountingEntity>([
  'stock',
  'statements',
  'payroll_costs',
  'party_balances',
  'product_prices',
  ...OPTIONAL_ENTITIES,
]);

/** ¿Un error del programa que significa «esto no está disponible aquí»? */
export function isUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 404 || status === 405 || status === 403 || status === 400;
}

export const ENTITY_ORDER: readonly AccountingEntity[] = ACCOUNTING_ENTITIES;

export interface EntityPlan {
  queries: Array<Record<string, string>>;
  index: number;
  page: number;
  startedAt: string;
  mode: 'initial' | 'sweep' | 'incremental';
  /** Hoy no toca: se revisó hace menos de un día. */
  skip?: boolean;
}

/** Qué pedir de una cosa en esta corrida. Puro. */
export function planEntity(
  provider: Pick<AccountingProvider, 'id' | 'queries'>,
  entity: AccountingEntity,
  cursor: EntityCursor | undefined,
  now: Date,
): EntityPlan {
  if (cursor?.resume?.queries?.length) return { ...cursor.resume };
  const startedAt = now.toISOString();
  const today = bogotaToday(now);
  const queriesFor = (input: Parameters<AccountingProvider['queries']>[1]) =>
    isMonthlyDerived(entity)
      ? derivedMonthQueries(
          input.mode,
          today,
          entity === 'party_balances' ? PARTY_HISTORY_MONTHS : undefined,
        )
      : provider.queries(entity, input);
  if (!cursor?.since || (provider.id === 'siigo' && cursor.coverage_version !== 2))
    return {
      queries: queriesFor({ mode: 'initial', now }),
      index: 0,
      page: 1,
      startedAt,
      mode: 'initial',
    };
  // Catálogos y estados mensuales: una vez al día.
  if (DAILY_ENTITIES.has(entity) && now.getTime() - Date.parse(cursor.since) < SWEEP_EVERY_MS)
    return { queries: [], index: 0, page: 1, startedAt, mode: 'incremental', skip: true };
  const since = new Date(Date.parse(cursor.since) - OVERLAP_MS).toISOString();
  const incremental = queriesFor({ mode: 'incremental', since, now });
  const sweepDue =
    SWEEP_ENTITIES.has(entity) &&
    (!cursor.full_at || now.getTime() - Date.parse(cursor.full_at) >= SWEEP_EVERY_MS);
  if (sweepDue)
    return {
      queries: [...queriesFor({ mode: 'sweep', now }), ...incremental],
      index: 0,
      page: 1,
      startedAt,
      mode: 'sweep',
    };
  return { queries: incremental, index: 0, page: 1, startedAt, mode: 'incremental' };
}

/** El cursor que queda cuando una cosa terminó completa. */
export function finishedCursor(plan: EntityPlan, previous: EntityCursor | undefined): EntityCursor {
  return {
    since: plan.startedAt,
    ...(plan.mode === 'initial'
      ? { coverage_version: 2 }
      : previous?.coverage_version
        ? { coverage_version: previous.coverage_version }
        : {}),
    ...(plan.mode !== 'incremental'
      ? { full_at: plan.startedAt }
      : previous?.full_at
        ? { full_at: previous.full_at }
        : {}),
    ...(previous?.audit ? { audit: previous.audit } : {}),
  };
}

/**
 * Compara lo que dice el programa con lo que hay en la tabla. Si el programa
 * tiene más y la corrida no era una carga completa, se pide una carga completa
 * (se suelta `since`) y se anota la diferencia; si ya se hizo con la misma
 * diferencia —registros que no se pueden leer—, sólo se avisa. Puro.
 */
export function auditCoverage(input: {
  label: string;
  remote: number;
  local: number;
  cursor: EntityCursor;
  skipped: number;
  fullPass: boolean;
}): { cursor: EntityCursor; warning?: string; reload: boolean } {
  const { remote, local, cursor, label } = input;
  const gap = remote - local;
  if (gap <= 0) {
    const { audit: _drop, ...rest } = cursor;
    return { cursor: rest, reload: false };
  }
  const known = cursor.audit?.remote === remote && cursor.audit?.local === local;
  if (!input.fullPass && !known)
    return {
      cursor: {
        ...(cursor.coverage_version ? { coverage_version: cursor.coverage_version } : {}),
        audit: { remote, local },
      },
      warning: `El programa tiene ${remote} ${label} y la tabla ${local}: faltan ${gap}. Repito la carga completa en la próxima corrida.`,
      reload: true,
    };
  return {
    cursor: { ...cursor, audit: { remote, local } },
    warning: `El programa tiene ${remote} ${label} y la tabla ${local}: faltan ${gap}${input.skipped ? ` (${input.skipped} no se pudieron leer)` : ' y no logré traerlos'}. Revísalo antes de confiar en los totales.`,
    reload: false,
  };
}

// ---------------------------------------------------------------------------
// La tabla de cada cosa
// ---------------------------------------------------------------------------

type TableHandle = Pick<TrackerRow, 'id' | 'slug' | 'name' | 'description' | 'fields'>;

function sameField(a: TrackerField, b: TrackerField): boolean {
  return (
    a.type === b.type &&
    JSON.stringify([...(a.options ?? [])].sort()) === JSON.stringify([...(b.options ?? [])].sort())
  );
}

/**
 * La tabla de una cosa, creada si no existe. Si existe y alguien le cambió un
 * campo del programa (tipo u opciones), se le devuelve su forma —con la
 * etiqueta que le hayan puesto— para que las filas sigan entrando; si le
 * borraron uno, vuelve. Los campos que el equipo agregó se quedan.
 */
export async function ensureAccountingTable(
  db: SupabaseClient,
  spec: AccountingTableSpec,
  knownId: string | undefined,
  userId: string,
  /** La conexión que la llena: deja la marca de origen (0237) en la tabla. */
  origin?: { connectionId: string; provider: string },
): Promise<TableHandle> {
  const table = await ensureTable(db, spec, knownId, userId);
  if (origin)
    await setTrackerOrigin(db, table.id, {
      kind: 'accounting',
      provider: origin.provider,
      label: ORIGIN_NAME[origin.provider] ?? origin.provider,
      ref: origin.connectionId,
      // Los campos del programa; los que el equipo agregó encima son propios.
      fields: spec.fields.map((f) => f.key),
      creates: true,
    });
  return table;
}

const ORIGIN_NAME: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

async function ensureTable(
  db: SupabaseClient,
  spec: AccountingTableSpec,
  knownId: string | undefined,
  userId: string,
): Promise<TableHandle> {
  const existing =
    (knownId ? await getTrackerById(db, knownId) : null) ?? (await getTrackerBySlug(db, spec.slug));
  if (!existing) {
    const { tracker } = await defineTracker(db, {
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      fields: trackerFieldsSchema.parse(spec.fields),
      userId,
      system: true,
    });
    return tracker;
  }
  const ours = new Map(spec.fields.map((f) => [f.key, f]));
  let changed = false;
  const merged: TrackerField[] = existing.fields.map((f) => {
    const mine = ours.get(f.key);
    if (!mine || sameField(f, mine)) return f;
    changed = true;
    return { ...mine, label: f.label };
  });
  for (const f of spec.fields)
    if (!merged.some((m) => m.key === f.key)) {
      merged.push(f);
      changed = true;
    }
  if (!changed) return existing;
  // Tope de 20 campos: si el equipo agregó muchos, los del programa van primero.
  let fields = merged;
  while (fields.length > 20) {
    const extra = [...fields].reverse().find((f) => !ours.has(f.key));
    if (!extra) break;
    fields = fields.filter((f) => f !== extra);
  }
  const { tracker } = await defineTracker(db, {
    slug: existing.slug,
    name: existing.name,
    description: existing.description,
    fields: trackerFieldsSchema.parse(fields.slice(0, 20)),
    userId,
    system: true,
  });
  return tracker;
}

function emptyCounts(): EntityCounts {
  return { fetched: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
}

function sameOn(keys: string[], a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return keys.every((k) => String(a[k] ?? '') === String(b[k] ?? ''));
}

/**
 * Escribe filas en la tabla por su clave externa. Nueva → insert (en lote);
 * cambiada en algún campo del programa → update de esa fila, conservando los
 * campos que el equipo llena a mano; igual → nada.
 */
export async function upsertAccountingRows(
  db: SupabaseClient,
  table: TableHandle,
  rows: Array<{ key: string; values: Record<string, string | number> }>,
  createdBy: string,
  counts: EntityCounts,
  newLabels: string[],
  opts: { backfill?: boolean } = {},
): Promise<void> {
  const befores = new Map<string, Record<string, unknown>>();
  const wroteSince = new Date(Date.now() - 2000).toISOString();
  const known = new Set(table.fields.map((f) => f.key));
  const byKey = new Map<string, Record<string, string | number>>();
  for (const r of rows) if (r.key) byKey.set(r.key.slice(0, 400), r.values);
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, external_key, values')
      .eq('tracker_id', table.id)
      .in('external_key', chunk);
    if (error) throw error;
    const existing = new Map(
      (
        (data ?? []) as Array<{ id: string; external_key: string; values: Record<string, unknown> }>
      ).map((r) => [r.external_key, r]),
    );
    const inserts: Array<Record<string, unknown>> = [];
    for (const key of chunk) {
      const ours = byKey.get(key) ?? {};
      const found = existing.get(key);
      const base = found
        ? Object.fromEntries(Object.entries(found.values ?? {}).filter(([k]) => known.has(k)))
        : {};
      let values: Record<string, string | number>;
      try {
        const shaped = shapeValuesDetailed(table.fields, { ...base, ...ours }, { lenient: true });
        values = markForReview(table, shaped.values, shaped.violations);
      } catch {
        counts.skipped += 1;
        continue;
      }
      const label = rowLabel(table.fields, values);
      if (!found) {
        inserts.push({
          tracker_id: table.id,
          label,
          values,
          external_key: key,
          created_by: createdBy,
        });
        continue;
      }
      // Una copia de lo de antes, por si la lectura comparte objeto con lo que se escribe.
      const beforeValues = { ...(found.values ?? {}) };
      if (sameOn(Object.keys(ours), found.values ?? {}, values)) {
        counts.unchanged += 1;
        continue;
      }
      const { error: updateError } = await db
        .from('tracker_rows')
        .update({ label, values, updated_at: new Date().toISOString() })
        .eq('id', found.id)
        .eq('tracker_id', table.id);
      if (updateError) throw updateError;
      counts.updated += 1;
      // Lo que tenía antes: «una factura queda pagada» se detecta comparando (0232).
      befores.set(key, beforeValues);
    }
    if (!inserts.length) continue;
    const { error: insertError } = await db.from('tracker_rows').insert(inserts);
    if (!insertError) {
      counts.inserted += inserts.length;
      for (const r of inserts) newLabels.push(String(r.label));
      continue;
    }
    if ((insertError as { code?: string }).code !== '23505') throw insertError;
    // Otra corrida metió alguna entre la lectura y ésta: fila por fila, y la
    // que ya estaba no es un error.
    for (const r of inserts) {
      const { error: oneError } = await db.from('tracker_rows').insert(r);
      if (!oneError) {
        counts.inserted += 1;
        newLabels.push(String(r.label));
      } else if ((oneError as { code?: string }).code === '23505') counts.unchanged += 1;
      else throw oneError;
    }
  }
  // Avisa a las automatizaciones de la app que miran esta tabla (0210).
  if (counts.inserted || counts.updated)
    await emitSyncEvents(db, table, wroteSince, {
      befores: befores as Map<string, Record<string, string | number>>,
      backfill: opts.backfill,
    });
}

// ---------------------------------------------------------------------------
// La corrida
// ---------------------------------------------------------------------------

export interface SyncDeps {
  session: ProviderSession;
  /** Hora de la corrida. */
  now?: Date;
  /** Epoch (ms) a partir del cual no se pide otra página. */
  deadline?: number;
  clock?: () => number;
  importPayments?: typeof importSystemPayments;
  /**
   * 0183: los productos también entran al catálogo de inventario (con sus
   * existencias si el programa las da). Lo pasa el trabajo programado
   * (inventory/products.ts › importAccountingProducts); sin él, sólo la tabla.
   * Un fallo aquí no tumba la sincronización: se cuenta y sigue.
   */
  importProducts?: (
    db: SupabaseClient,
    input: { provider: string; records: NormalizedProduct[]; userId: string | null; today: string },
  ) => Promise<{ created: number; updated: number; adjusted: number }>;
  /**
   * 0234: las compras que entran a la tabla también entran a cuentas por pagar
   * (con dedupe contra lo que llegó por correo o a mano); una compra que el
   * programa ya muestra pagada marca la factura pagada. Sin esto, sólo la tabla.
   */
  importPurchases?: ImportPurchases;
  /** Para probar sin el reloj. */
  readMonth?: typeof readStatementMonth;
  readPartyMonth?: typeof readPartyBalanceMonth;
}

/** 0234: lo que el motor necesita para llevar las compras a cuentas por pagar (lo pasa el trabajo programado). */
export type ImportPurchases = (
  db: SupabaseClient,
  purchases: readonly NormalizedPurchase[],
  opts: { system: string; today: string },
) => Promise<{ created: number; duplicates: number; paid: number; errors: string[] }>;

export interface SyncRunOutcome {
  result: RunResult;
  /** Etiquetas de filas nuevas por cosa (para la campana). */
  newLabels: Partial<Record<AccountingEntity, string[]>>;
  /** Terminó la primera carga completa en esta corrida. */
  completedInitial: boolean;
}

async function clientsByNit(db: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await db.from('clients').select('id, tax_id').limit(5000);
  if (error) throw error;
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const c of (data ?? []) as Array<{ id: string; tax_id: string | null }>) {
    const nit = (c.tax_id ?? '').replace(/\D/g, '');
    if (!nit) continue;
    if (map.has(nit)) ambiguous.add(nit);
    map.set(nit, c.id);
  }
  // Dos clientes con el mismo NIT: no se elige uno.
  for (const nit of ambiguous) map.delete(nit);
  return map;
}

/** Nombres de clientes del programa que no están en memoria, desde su tabla. */
async function loadCustomerNames(
  db: SupabaseClient,
  customersTableId: string | undefined,
  ids: string[],
  names: Map<string, string>,
): Promise<void> {
  const missing = [...new Set(ids.filter((id) => id && !names.has(id)))];
  if (!customersTableId || !missing.length) return;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('external_key, values')
      .eq('tracker_id', customersTableId)
      .in('external_key', missing.slice(i, i + CHUNK));
    if (error) throw error;
    for (const r of (data ?? []) as Array<{
      external_key: string;
      values: Record<string, unknown>;
    }>) {
      const name = r.values?.nombre;
      if (typeof name === 'string' && name) names.set(r.external_key, name);
    }
  }
}

/** NIT (sólo dígitos, sin DV) → nombre, de la tabla de clientes; para los terceros de los movimientos. */
async function loadNamesByNit(
  db: SupabaseClient,
  customersTableId: string | undefined,
  nits: string[],
  names: Map<string, string>,
): Promise<void> {
  const missing = [...new Set(nits.map((n) => n.replace(/\D/g, '')).filter((n) => n && !names.has(n)))];
  if (!customersTableId || !missing.length) return;
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    const { data, error } = await db
      .from('tracker_rows')
      .select('values')
      .eq('tracker_id', customersTableId)
      .or(chunk.map((n) => `values->>nit.like.${n}%`).join(','))
      .limit(200);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ values: Record<string, unknown> }>) {
      const nit = String(r.values?.nit ?? '').replace(/\D/g, '');
      const name = r.values?.nombre;
      if (typeof name !== 'string' || !name) continue;
      // «9001234567» puede ser 900123456 + DV 7: se asigna al NIT pedido que lo empieza.
      for (const wanted of chunk) if (nit === wanted || nit.startsWith(wanted)) names.set(wanted, name);
    }
  }
  // Los que no se encontraron se recuerdan vacíos: no se vuelven a buscar en esta corrida.
  for (const n of missing) if (!names.has(n)) names.set(n, '');
}

/** Un catálogo (centros de costo, vendedores) → id del programa → nombre. */
async function loadCatalogNames(
  db: SupabaseClient,
  tableId: string | undefined,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!tableId) return map;
  const { data, error } = await db
    .from('tracker_rows')
    .select('external_key, values')
    .eq('tracker_id', tableId)
    .limit(2000);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ external_key: string; values: Record<string, unknown> }>) {
    const name = r.values?.nombre;
    if (typeof name === 'string' && name) map.set(r.external_key, name);
  }
  return map;
}

/** Los terceros de cuyos nombres hace falta leer la tabla de clientes (por id del programa). */
function missingPartyIds(kind: AccountingEntity, records: NormalizedRecord[]): string[] {
  const ids: string[] = [];
  for (const r of records) {
    if (kind === 'invoices' || kind === 'payments' || kind === 'credit_notes' || kind === 'quotations') {
      const x = r as { customerName?: string; customerExternalId?: string };
      if (!x.customerName && x.customerExternalId) ids.push(x.customerExternalId);
    } else if (kind === 'purchases' || kind === 'supplier_payments') {
      const x = r as { supplierName?: string | null; supplierExternalId?: string };
      if (!x.supplierName && x.supplierExternalId) ids.push(x.supplierExternalId);
    } else if (kind === 'journal_lines') {
      const x = r as NormalizedJournalLine;
      if (!x.confidential && !x.partyName && x.partyExternalId) ids.push(x.partyExternalId);
    }
  }
  return ids;
}

/**
 * Un vencimiento que ya no sale en el reporte oficial de cuentas por pagar se
 * saldó (el reporte sólo trae lo que falta): se marca «Saldada» con saldo cero
 * en vez de dejarlo como deuda. Sólo se llama tras leer el reporte completo.
 */
export async function retireUnseenPayables(
  db: SupabaseClient,
  tableId: string,
  today: string,
): Promise<number> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, values')
    .eq('tracker_id', tableId)
    .lt('values->>ultima_lectura', today)
    .limit(1000);
  if (error) throw error;
  let retired = 0;
  for (const r of (data ?? []) as Array<{ id: string; values: Record<string, unknown> }>) {
    if (r.values?.estado === 'Saldada') continue;
    const values = { ...r.values, estado: 'Saldada', saldo: 0, saldo_extranjero: 0 };
    const { error: updateError } = await db
      .from('tracker_rows')
      .update({ values, updated_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('tracker_id', tableId);
    if (updateError) throw updateError;
    retired += 1;
  }
  return retired;
}

async function writeReceivables(
  db: SupabaseClient,
  rows: AccountingInvoiceInput[],
): Promise<number> {
  const unique = [...new Map(rows.map((r) => [r.source_ref, r])).values()];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { error } = await db.from('accounting_invoices').upsert(unique.slice(i, i + CHUNK), {
      onConflict: 'organization_id,source_system,source_ref',
    });
    if (error) throw error;
  }
  return unique.length;
}

/**
 * Una corrida completa para una conexión. No lanza por fallas del programa:
 * devuelve `status: 'error'` con el motivo y lo que alcanzó a avanzar, para
 * que la próxima corrida no repita lo ya traído.
 */
export async function runAccountingSync(
  db: SupabaseClient,
  conn: AccountingConnectionRow,
  deps: SyncDeps,
): Promise<SyncRunOutcome> {
  const provider = getAccountingProvider(conn.provider);
  if (!provider)
    return {
      result: { status: 'error', error: `Todavía no se puede sincronizar «${conn.provider}».` },
      newLabels: {},
      completedInitial: false,
    };
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const deadline = deps.deadline ?? clock() + 8 * 60_000;
  const importPayments = deps.importPayments ?? importSystemPayments;
  const today = bogotaToday(now);

  const cursors: AccountingConnectionRow['cursors'] = { ...(conn.cursors ?? {}) };
  const trackers: AccountingConnectionRow['trackers'] = { ...(conn.trackers ?? {}) };
  const counts: RunCounts = {};
  const newLabels: Partial<Record<AccountingEntity, string[]>> = {};
  const names = new Map<string, string>();
  const nitNames = new Map<string, string>();
  let catalogNames: { costCenters: Map<string, string>; sellers: Map<string, string> } | null = null;
  let stockTable: TableHandle | null = null;
  let pricesTable: TableHandle | null = null;
  const notes: string[] = [];
  const refreshPurchaseNumbers = new Set<string>();
  let clientIds: Map<string, string> | null = null;
  let partial = false;
  let ranInitial = false;
  const refreshNumbers = new Set<string>();
  const warnings: string[] = [];
  const entities = ENTITY_ORDER.filter(
    (e) => conn.entities.includes(e) && provider.entities.includes(e),
  );

  try {
    // Toda cosa elegida tiene su tabla desde la primera corrida, aunque le toque
    // más tarde: antes, «costo de nómina» no existía hasta que los 24 meses de
    // estados financieros (que van antes y se reanudan por tandas) terminaban.
    for (const entity of entities) {
      if (trackers[entity]) continue;
      const t = await ensureAccountingTable(
        db,
        accountingTableSpec(provider, entity),
        undefined,
        conn.created_by, { connectionId: conn.id, provider: conn.provider });
      trackers[entity] = t.id;
    }
    for (const entity of entities) {
      // Las existencias y los precios por lista salen de la misma lectura de productos: aquí sólo la tabla.
      if (entity === 'stock' || entity === 'product_prices') {
        const t = await ensureAccountingTable(
          db,
          accountingTableSpec(provider, entity),
          trackers[entity],
          conn.created_by, { connectionId: conn.id, provider: conn.provider });
        trackers[entity] = t.id;
        continue;
      }
      const spec = accountingTableSpec(provider, entity);
      const table = await ensureAccountingTable(db, spec, trackers[entity], conn.created_by, { connectionId: conn.id, provider: conn.provider });
      trackers[entity] = table.id;
      const entityCounts = emptyCounts();
      counts[entity] = entityCounts;
      const labels: string[] = [];
      newLabels[entity] = labels;
      if (entity === 'products' && entities.includes('stock'))
        stockTable = await ensureAccountingTable(
          db,
          accountingTableSpec(provider, 'stock'),
          trackers.stock,
          conn.created_by, { connectionId: conn.id, provider: conn.provider });
      if (stockTable) trackers.stock = stockTable.id;
      if (entity === 'products' && entities.includes('product_prices'))
        pricesTable = await ensureAccountingTable(
          db,
          accountingTableSpec(provider, 'product_prices'),
          trackers.product_prices,
          conn.created_by, { connectionId: conn.id, provider: conn.provider });
      if (pricesTable) trackers.product_prices = pricesTable.id;
      const plan = planEntity(provider, entity, cursors[entity], now);
      // Catálogos y estados: una vez al día; hoy no toca.
      if (plan.skip) continue;
      if (plan.mode === 'initial' && !SOFT_ENTITIES.has(entity)) ranInitial = true;

      const processRecords = async (kind: AccountingEntity, records: NormalizedRecord[]) => {
        if (!records.length) return;
        if (kind === 'customers')
          for (const c of records as NormalizedCustomer[])
            if (c.name) names.set(c.externalId, c.name);
        await loadCustomerNames(db, trackers.customers, missingPartyIds(kind, records), names);
        if (kind === 'journal_lines')
          await loadNamesByNit(
            db,
            trackers.customers,
            (records as NormalizedJournalLine[])
              .filter((l) => !l.confidential && !l.partyName && l.partyTaxId)
              .map((l) => l.partyTaxId as string),
            nitNames,
          );
        if ((kind === 'journal_lines' || kind === 'quotations') && !catalogNames) {
          catalogNames = {
            costCenters: await loadCatalogNames(db, trackers.cost_centers),
            sellers: await loadCatalogNames(db, trackers.sellers),
          };
        }
        const ctx = {
          today,
          customerNames: names,
          nitNames,
          costCenterNames: catalogNames?.costCenters,
          sellerNames: catalogNames?.sellers,
          provider: deps.session.documents ? provider.id : undefined,
        };
        await upsertAccountingRows(
          db,
          table,
          records.map((r) => ({ key: r.externalId, values: valuesFor(kind, r, ctx) })),
          conn.created_by,
          entityCounts,
          labels,
          { backfill: plan.mode === 'initial' },
        );
        if (kind === 'invoices') {
          clientIds ??= await clientsByNit(db);
          const map = clientIds;
          counts.receivables =
            (counts.receivables ?? 0) +
            (await writeReceivables(
              db,
              (records as NormalizedInvoice[]).map((inv) =>
                receivableFor(provider.id, inv, {
                  ...ctx,
                  clientIdByNit: map,
                  now: now.toISOString(),
                }),
              ),
            ));
        }
        if (kind === 'products' && deps.importProducts) {
          try {
            const imported = await deps.importProducts(db, {
              provider: provider.id,
              records: records as NormalizedProduct[],
              userId: conn.created_by ?? null,
              today,
            });
            counts.inventory_products =
              (counts.inventory_products ?? 0) + imported.created + imported.updated;
            counts.inventory_adjusted = (counts.inventory_adjusted ?? 0) + imported.adjusted;
          } catch {
            counts.inventory_errors = (counts.inventory_errors ?? 0) + 1;
          }
        }
        if (kind === 'products' && stockTable) {
          const lines = (records as NormalizedProduct[]).flatMap(stockLinesFromProduct);
          if (lines.length) {
            const stockCounts = counts.stock ?? emptyCounts();
            counts.stock = stockCounts;
            const stockLabels = newLabels.stock ?? [];
            newLabels.stock = stockLabels;
            stockCounts.fetched += lines.length;
            await upsertAccountingRows(
              db,
              stockTable,
              lines.map((l) => ({ key: l.externalId, values: stockValues(l, ctx) })),
              conn.created_by,
              stockCounts,
              stockLabels,
              { backfill: plan.mode === 'initial' },
            );
          }
        }
        if (kind === 'products' && pricesTable) {
          const lines = (records as NormalizedProduct[]).flatMap(productPriceLines);
          if (lines.length) {
            const priceCounts = counts.product_prices ?? emptyCounts();
            counts.product_prices = priceCounts;
            const priceLabels = newLabels.product_prices ?? [];
            newLabels.product_prices = priceLabels;
            priceCounts.fetched += lines.length;
            await upsertAccountingRows(
              db,
              pricesTable,
              lines.map((l) => ({ key: l.externalId, values: productPriceValues(l) })),
              conn.created_by,
              priceCounts,
              priceLabels,
              { backfill: plan.mode === 'initial' },
            );
          }
        }
        if (kind === 'purchases') {
          if (deps.importPurchases) {
            try {
              const imported = await deps.importPurchases(db, records as NormalizedPurchase[], {
                system: provider.id,
                today,
              });
              counts.payables_created = (counts.payables_created ?? 0) + imported.created;
              counts.payables_paid = (counts.payables_paid ?? 0) + imported.paid;
              if (imported.errors.length)
                warnings.push(
                  `${imported.errors.length} compra(s) no pasaron a cuentas por pagar: ${imported.errors[0]}`,
                );
            } catch (err) {
              warnings.push(
                `Las compras no pasaron a cuentas por pagar: ${err instanceof Error ? err.message : 'falló la importación'}.`,
              );
            }
          }
        }
        if (kind === 'supplier_payments' && plan.mode !== 'initial')
          // Un egreso baja el saldo de la compra sin «modificarla»: se vuelve a leer ya.
          for (const p of records as NormalizedSupplierPayment[])
            for (const a of p.applications) if (a.purchaseNumber) refreshPurchaseNumbers.add(a.purchaseNumber);
        if (kind === 'payments') {
          const rows = (records as NormalizedPayment[]).flatMap((p) =>
            paymentRowsFor(p, provider.name),
          );
          if (rows.length) {
            const imported = await importPayments(db, {
              system: provider.id,
              readAt: now.toISOString(),
              rows,
              createdBy: conn.created_by,
            });
            counts.payments_created = (counts.payments_created ?? 0) + imported.created;
          }
          // Un recibo baja el saldo de la factura sin marcarla «modificada» (0232):
          // se vuelve a leer ya, en vez de esperar al repaso diario, para que
          // «la factura queda pagada» salga a los minutos.
          if (plan.mode !== 'initial')
            for (const p of records as NormalizedPayment[])
              for (const a of p.applications) if (a.invoiceNumber) refreshNumbers.add(a.invoiceNumber);
        }
      };

      let finished = true;
      let pages = 0;
      outer: for (let qi = plan.index; qi < plan.queries.length; qi++) {
        const query = plan.queries[qi] ?? {};
        for (let page = qi === plan.index ? plan.page : 1; ; page++) {
          if (clock() >= deadline || pages >= MAX_PAGES_PER_RUN) {
            cursors[entity] = {
              ...cursors[entity],
              resume: { ...plan, index: qi, page },
            };
            finished = false;
            break outer;
          }
          let result: Awaited<ReturnType<ProviderSession['listPage']>>;
          if (isMonthlyDerived(entity)) {
            // Estados y costo de nómina: un mes por consulta, de la copia o del programa.
            const reports = deps.session.reports;
            if (!reports) {
              warnings.push(`${provider.name} no entrega estados financieros por API.`);
              result = { records: [], hasMore: false };
            } else if (entity === 'party_balances') {
              try {
                const month = query.month ?? today.slice(0, 7);
                const reading = await (deps.readPartyMonth ?? readPartyBalanceMonth)(db, {
                  provider: provider.id,
                  reports,
                  month,
                  today,
                  userId: conn.created_by ?? null,
                });
                result = {
                  records: partyBalanceLines(month, reading.rows, reading.inProgress),
                  hasMore: false,
                };
              } catch (err) {
                if (!isUnavailableError(err) && !(err instanceof Error && /reconoc|descarg|entreg|devolvi/.test(err.message)))
                  throw err;
                warnings.push(
                  `No pude leer saldos por tercero de ${query.month}: ${err instanceof Error ? err.message : 'falló la lectura'}`,
                );
                result = { records: [], hasMore: false };
              }
            } else
            try {
              const reading = await (deps.readMonth ?? readStatementMonth)(db, {
                provider: provider.id,
                reports,
                month: query.month ?? today.slice(0, 7),
                today,
                userId: conn.created_by ?? null,
                want: {
                  pnl: true,
                  balance: entity === 'statements',
                  personnel: entity === 'payroll_costs',
                },
              });
              result = {
                records: recordsForMonth(entity, query.month ?? today.slice(0, 7), reading),
                hasMore: false,
              };
            } catch (err) {
              // Un mes que el programa no entrega no frena el resto: se avisa; el
              // mes en curso y el anterior se reintentan en la próxima revisión diaria.
              warnings.push(
                `No pude leer ${ENTITY_LABEL[entity]} de ${query.month}: ${err instanceof Error ? err.message : 'falló la lectura'}`,
              );
              result = { records: [], hasMore: false };
            }
          } else {
            try {
              result = await deps.session.listPage(entity, query, page);
            } catch (err) {
              if (!OPTIONAL_ENTITIES.has(entity) || !isUnavailableError(err)) throw err;
              // Un listado que este programa no entrega (o no permite) no tumba el resto.
              notes.push(
                `${ENTITY_LABEL[entity]}: el programa no lo entrega por API${err instanceof Error ? ` (${err.message.split('.')[0]})` : ''}.`,
              );
              result = { records: [], hasMore: false };
            }
          }
          pages += 1;
          entityCounts.fetched += result.records.length;
          entityCounts.skipped += result.skipped ?? 0;
          await processRecords(entity, result.records);
          if (!result.hasMore) break;
        }
      }
      if (finished) {
        cursors[entity] = finishedCursor(plan, cursors[entity]);
        if (entity === 'accounts_payable' && !notes.some((n) => n.startsWith(ENTITY_LABEL[entity])))
          counts.payables_retired =
            (counts.payables_retired ?? 0) + (await retireUnseenPayables(db, table.id, today));
        // ¿Quedó corta? Se compara con el total que dice el programa.
        if (deps.session.remoteTotal && AUDITED_ENTITIES.has(entity)) {
          try {
            const remote = await deps.session.remoteTotal(entity);
            if (remote !== null) {
              const { count, error } = await db
                .from('tracker_rows')
                .select('id', { count: 'exact', head: true })
                .eq('tracker_id', table.id);
              if (error) throw error;
              const audited = auditCoverage({
                label: ENTITY_LABEL[entity],
                remote,
                local: count ?? 0,
                cursor: cursors[entity] ?? {},
                skipped: entityCounts.skipped,
                fullPass: plan.mode === 'initial',
              });
              cursors[entity] = audited.cursor;
              if (audited.warning) warnings.push(audited.warning);
              if (audited.reload) partial = true;
            }
          } catch {
            // La comprobación no tumba la sincronización.
          }
        }
      } else {
        partial = true;
        // Lo que sigue en la lista espera a la próxima corrida, en orden.
        break;
      }
    }
    if (
      refreshNumbers.size &&
      deps.session.refreshInvoices &&
      trackers.invoices &&
      entities.includes('invoices')
    ) {
      try {
        const fresh = await deps.session.refreshInvoices([...refreshNumbers]);
        if (fresh.length) {
          const table = await ensureAccountingTable(
            db,
            accountingTableSpec(provider, 'invoices'),
            trackers.invoices,
            conn.created_by, { connectionId: conn.id, provider: conn.provider });
          await loadCustomerNames(
            db,
            trackers.customers,
            fresh.filter((r) => !r.customerName && r.customerExternalId).map((r) => r.customerExternalId as string),
            names,
          );
          const ctx = {
            today,
            customerNames: names,
            provider: deps.session.documents ? provider.id : undefined,
          };
          const c = counts.invoices ?? emptyCounts();
          counts.invoices = c;
          await upsertAccountingRows(
            db,
            table,
            fresh.map((r) => ({ key: r.externalId, values: valuesFor('invoices', r, ctx) })),
            conn.created_by,
            c,
            [],
            { backfill: false },
          );
          clientIds ??= await clientsByNit(db);
          const map = clientIds;
          counts.receivables =
            (counts.receivables ?? 0) +
            (await writeReceivables(
              db,
              fresh.map((inv) =>
                receivableFor(provider.id, inv, { ...ctx, clientIdByNit: map, now: now.toISOString() }),
              ),
            ));
        }
      } catch {
        // El repaso diario las alcanza: no tumba la sincronización.
      }
    }
    // Lo mismo con las compras que un egreso acaba de pagar: se vuelven a leer
    // para que su saldo —y cuentas por pagar— queden al día a los minutos.
    if (
      refreshPurchaseNumbers.size &&
      deps.session.refreshPurchases &&
      trackers.purchases &&
      entities.includes('purchases')
    ) {
      try {
        const fresh = await deps.session.refreshPurchases([...refreshPurchaseNumbers]);
        if (fresh.length) {
          const table = await ensureAccountingTable(
            db,
            accountingTableSpec(provider, 'purchases'),
            trackers.purchases,
            conn.created_by, { connectionId: conn.id, provider: conn.provider });
          await loadCustomerNames(db, trackers.customers, missingPartyIds('purchases', fresh), names);
          const ctx = { today, customerNames: names };
          const c = counts.purchases ?? emptyCounts();
          counts.purchases = c;
          await upsertAccountingRows(
            db,
            table,
            fresh.map((r) => ({ key: r.externalId, values: valuesFor('purchases', r, ctx) })),
            conn.created_by,
            c,
            [],
            { backfill: false },
          );
          if (deps.importPurchases)
            await deps.importPurchases(db, fresh, { system: provider.id, today });
        }
      } catch {
        // El repaso diario las alcanza: no tumba la sincronización.
      }
    }
  } catch (err) {
    counts.requests = deps.session.requests;
    return {
      result: {
        status: 'error',
        error: err instanceof Error ? err.message : 'No se pudo sincronizar.',
        cursors,
        trackers,
      },
      newLabels,
      completedInitial: false,
    };
  }

  counts.requests = deps.session.requests;
  if (warnings.length) counts.warnings = warnings;
  if (notes.length) counts.notes = [...new Set(notes)];
  const stillLoading = entities.some(
    (e) => !SOFT_ENTITIES.has(e) && (!cursors[e]?.since || cursors[e]?.resume),
  );
  return {
    result: { status: partial ? 'partial' : 'ok', counts, cursors, trackers },
    newLabels,
    // Una carga reanudada conserva su modo 'initial', así que la corrida que
    // termina la primera carga —aunque sea la tercera— es la que avisa.
    completedInitial: !partial && !stillLoading && ranInitial,
  };
}

// ---------------------------------------------------------------------------
// La campana
// ---------------------------------------------------------------------------

const NOUN: Record<AccountingEntity, [string, string]> = {
  customers: ['cliente nuevo', 'clientes nuevos'],
  products: ['producto nuevo', 'productos nuevos'],
  invoices: ['factura nueva', 'facturas nuevas'],
  payments: ['pago nuevo', 'pagos nuevos'],
  credit_notes: ['nota crédito nueva', 'notas crédito nuevas'],
  purchases: ['compra nueva', 'compras nuevas'],
  supplier_payments: ['pago a proveedor nuevo', 'pagos a proveedores nuevos'],
  journal_lines: ['movimiento contable nuevo', 'movimientos contables nuevos'],
  quotations: ['cotización nueva', 'cotizaciones nuevas'],
  stock: ['existencia nueva', 'existencias nuevas'],
  statements: ['renglón nuevo', 'renglones nuevos'],
  payroll_costs: ['renglón de nómina nuevo', 'renglones de nómina nuevos'],
  cost_centers: ['centro de costo nuevo', 'centros de costo nuevos'],
  taxes: ['impuesto nuevo', 'impuestos nuevos'],
  payment_methods: ['forma de pago nueva', 'formas de pago nuevas'],
  warehouses: ['bodega nueva', 'bodegas nuevas'],
  document_types: ['tipo de documento nuevo', 'tipos de documento nuevos'],
  sellers: ['vendedor nuevo', 'vendedores nuevos'],
  accounts_payable: ['vencimiento por pagar nuevo', 'vencimientos por pagar nuevos'],
  party_balances: ['saldo por tercero nuevo', 'saldos por tercero nuevos'],
  product_prices: ['precio nuevo', 'precios nuevos'],
  fixed_assets: ['activo fijo nuevo', 'activos fijos nuevos'],
  price_lists: ['lista de precios nueva', 'listas de precios nuevas'],
  account_groups: ['grupo de inventario nuevo', 'grupos de inventario nuevos'],
  expense_concepts: ['concepto de descuento nuevo', 'conceptos de descuento nuevos'],
  cities: ['ciudad nueva', 'ciudades nuevas'],
};

/**
 * Qué decir al terminar, o nada. Avisa cuando termina la primera carga, y
 * después sólo cuando entran facturas o pagos nuevos: un cliente o un producto
 * nuevo no merecen una campana cada hora.
 */
export function noticeFor(
  providerName: string,
  outcome: SyncRunOutcome,
  intervalMinutes: number,
  tableNames: string[],
): { title: string; body: string } | null {
  if (outcome.result.status !== 'ok') return null;
  if (outcome.completedInitial)
    return {
      title: `${providerName} ya está conectado`,
      body: `Ya traje todo a ${tableNames.join(', ')}. Desde ahora se actualiza solo cada ${intervalMinutes} minutos, y las facturas con saldo entran a la cartera.`,
    };
  const parts: string[] = [];
  const sample: string[] = [];
  for (const entity of ['invoices', 'payments', 'purchases', 'supplier_payments', 'quotations'] as const) {
    const n = outcome.result.counts[entity]?.inserted ?? 0;
    if (!n) continue;
    const [one, many] = NOUN[entity];
    parts.push(`${n} ${n === 1 ? one : many}`);
    sample.push(...(outcome.newLabels[entity] ?? []).slice(0, 3));
  }
  if (!parts.length) return null;
  return {
    title: `${providerName}: ${parts.join(', ')}`,
    body: `${parts.join(', ')}${sample.length ? `: ${sample.slice(0, 4).join(', ')}` : ''}.`,
  };
}
