import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { importSystemPayments } from '../payments/import';
import { type TrackerField, rowLabel, trackerFieldsSchema } from '../trackers/schema';
import {
  type TrackerRow,
  defineTracker,
  getTrackerById,
  getTrackerBySlug,
  markForReview,
  shapeValuesDetailed,
} from '../trackers/store';
import { getAccountingProvider } from './providers';
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
  receivableFor,
  valuesFor,
} from './tables';
import type {
  AccountingEntity,
  AccountingProvider,
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedProduct,
  NormalizedRecord,
  ProviderSession,
} from './types';
import { ACCOUNTING_ENTITIES } from './types';

/**
 * EL MOTOR: TRAER DE UN PROGRAMA CONTABLE A LAS TABLAS Y A LA CARTERA (0165).
 *
 * Una corrida, por cada cosa elegida y en este orden —clientes primero, para
 * que las facturas y los pagos salgan con el nombre del cliente—:
 *
 *   1. Decide qué pedir (`planEntity`): la primera vez, el último año; después,
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

export const ENTITY_ORDER: readonly AccountingEntity[] = ACCOUNTING_ENTITIES;

export interface EntityPlan {
  queries: Array<Record<string, string>>;
  index: number;
  page: number;
  startedAt: string;
  mode: 'initial' | 'sweep' | 'incremental';
}

/** Qué pedir de una cosa en esta corrida. Puro. */
export function planEntity(
  provider: Pick<AccountingProvider, 'queries'>,
  entity: AccountingEntity,
  cursor: EntityCursor | undefined,
  now: Date,
): EntityPlan {
  if (cursor?.resume?.queries?.length) return { ...cursor.resume };
  const startedAt = now.toISOString();
  if (!cursor?.since)
    return {
      queries: provider.queries(entity, { mode: 'initial', now }),
      index: 0,
      page: 1,
      startedAt,
      mode: 'initial',
    };
  const since = new Date(Date.parse(cursor.since) - OVERLAP_MS).toISOString();
  const incremental = provider.queries(entity, { mode: 'incremental', since, now });
  const sweepDue =
    entity === 'invoices' &&
    (!cursor.full_at || now.getTime() - Date.parse(cursor.full_at) >= SWEEP_EVERY_MS);
  if (sweepDue)
    return {
      queries: [...provider.queries(entity, { mode: 'sweep', now }), ...incremental],
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
    ...(plan.mode !== 'incremental'
      ? { full_at: plan.startedAt }
      : previous?.full_at
        ? { full_at: previous.full_at }
        : {}),
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
): Promise<void> {
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
}

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
  let clientIds: Map<string, string> | null = null;
  let partial = false;
  let ranInitial = false;
  const entities = ENTITY_ORDER.filter(
    (e) => conn.entities.includes(e) && provider.entities.includes(e),
  );

  try {
    for (const entity of entities) {
      const spec = accountingTableSpec(provider, entity);
      const table = await ensureAccountingTable(db, spec, trackers[entity], conn.created_by);
      trackers[entity] = table.id;
      const entityCounts = emptyCounts();
      counts[entity] = entityCounts;
      const labels: string[] = [];
      newLabels[entity] = labels;
      const plan = planEntity(provider, entity, cursors[entity], now);
      if (plan.mode === 'initial') ranInitial = true;

      const processRecords = async (kind: AccountingEntity, records: NormalizedRecord[]) => {
        if (!records.length) return;
        if (kind === 'customers')
          for (const c of records as NormalizedCustomer[])
            if (c.name) names.set(c.externalId, c.name);
        if (kind === 'invoices' || kind === 'payments')
          await loadCustomerNames(
            db,
            trackers.customers,
            (records as Array<NormalizedInvoice | NormalizedPayment>)
              .filter((r) => !r.customerName && r.customerExternalId)
              .map((r) => r.customerExternalId as string),
            names,
          );
        const ctx = { today, customerNames: names };
        await upsertAccountingRows(
          db,
          table,
          records.map((r) => ({ key: r.externalId, values: valuesFor(kind, r, ctx) })),
          conn.created_by,
          entityCounts,
          labels,
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
          const result = await deps.session.listPage(entity, query, page);
          pages += 1;
          entityCounts.fetched += result.records.length;
          entityCounts.skipped += result.skipped ?? 0;
          await processRecords(entity, result.records);
          if (!result.hasMore) break;
        }
      }
      if (finished) cursors[entity] = finishedCursor(plan, cursors[entity]);
      else {
        partial = true;
        // Lo que sigue en la lista espera a la próxima corrida, en orden.
        break;
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
  const stillLoading = entities.some((e) => !cursors[e]?.since || cursors[e]?.resume);
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
  for (const entity of ['invoices', 'payments'] as const) {
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
