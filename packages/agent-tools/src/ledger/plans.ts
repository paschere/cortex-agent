import { randomUUID } from 'node:crypto';
import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { forecast } from './forecast';
import { compareScenarios } from './forecast-explain';
import { PAYROLL_CONFIDENTIAL_KEY, isPayrollCategory } from './privacy';
import { detectRecurring } from './recurring';
import { addDays, monthOf, num, round2, toCategoryKey } from './shape';
import { listMovements, loadLedger } from './store';
import type {
  ForecastInput,
  ForecastResult,
  LedgerDirection,
  RecurringFlow,
  Scenario,
  ScenarioAdjustment,
} from './types';

/**
 * LOS PLANES SOBRE LA CAJA (migración 0173): lo que una persona decide sobre
 * la proyección, guardado, y la proyección lista para usar.
 *
 *   ESCENARIOS     `ledger_scenarios`: una etiqueta y sus ajustes. Guardar
 *                  otra vez la misma etiqueta la reemplaza.
 *   RECURRENTES    `ledger_recurring`: lo declarado («el crédito, 2 M el 28»)
 *                  se suma a lo detectado; lo detectado se confirma o se
 *                  ignora por su `detectedKey`, y lo ignorado no entra.
 *   CAJA MÍNIMA    `ledger_settings` (0175): el piso de la empresa. Sólo lo
 *                  fija quien administra o es dueño (`saveLedgerSettings`);
 *                  la proyección lo usa cuando nadie pide otro.
 *   PROYECCIÓN     `buildForecastInput` lee el libro y los planes y arma la
 *                  entrada del motor puro; `runForecast` la corre (base, y el
 *                  escenario contra la base si se pide).
 *   PÉRDIDAS Y     `monthlyPnl`: ventas, otros ingresos, gastos por categoría
 *   GANANCIAS      y margen por mes, de lo liquidado (caja). Sin permiso para
 *                  ver la nómina, ésta sale como un solo total confidencial.
 *
 * Esta es la API que usan la pantalla de Finanzas, el centro de mando, las
 * vistas y las herramientas del chat. Toda lectura revisa `error`; el `db`
 * llega con alcance de empresa.
 */

// ---------------------------------------------------------------------------
// La forma de un ajuste de escenario (la validan la pantalla y el chat)
// ---------------------------------------------------------------------------

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha tiene que ser AAAA-MM-DD.');
const MONEY = z.number().positive().max(1e13);

export const scenarioAdjustmentSchema: z.ZodType<ScenarioAdjustment> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('delay_counterparty'),
      counterpartyName: z.string().trim().min(1).max(200),
      days: z.number().int().min(-365).max(365),
    }),
    z.object({
      kind: z.literal('drop_counterparty'),
      counterpartyName: z.string().trim().min(1).max(200),
    }),
    z.object({
      kind: z.literal('add_recurring'),
      label: z.string().trim().min(1).max(120),
      direction: z.enum(['in', 'out']),
      amount: MONEY,
      every: z.enum(['week', 'month']),
      start: DAY,
    }),
    z.object({
      kind: z.literal('scale_category'),
      category: z.string().trim().min(1).max(40),
      factor: z.number().min(0).max(100),
    }),
    z.object({
      kind: z.literal('one_off'),
      label: z.string().trim().min(1).max(120),
      direction: z.enum(['in', 'out']),
      amount: MONEY,
      date: DAY,
    }),
  ],
) as z.ZodType<ScenarioAdjustment>;

export const scenarioAdjustmentsSchema = z.array(scenarioAdjustmentSchema).max(20);

function labelKey(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

interface ScenarioRow {
  id: string;
  label: string;
  label_key: string;
  adjustments: unknown;
  created_at: string;
  updated_at: string;
}

const SCENARIO_COLUMNS = 'id, label, label_key, adjustments, created_at, updated_at';

function rowToScenario(row: ScenarioRow): Scenario {
  const parsed = scenarioAdjustmentsSchema.safeParse(row.adjustments);
  return { id: row.id, label: row.label, adjustments: parsed.success ? parsed.data : [] };
}

/** Los escenarios guardados, el más reciente primero. */
export async function listScenarios(db: SupabaseClient): Promise<Scenario[]> {
  const { data, error } = await db
    .from('ledger_scenarios')
    .select(SCENARIO_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as ScenarioRow[]).map(rowToScenario);
}

export async function getScenario(db: SupabaseClient, id: string): Promise<Scenario | null> {
  const { data, error } = await db
    .from('ledger_scenarios')
    .select(SCENARIO_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToScenario(data as ScenarioRow) : null;
}

/**
 * Guardar un escenario. Con `id`, cambia ése; sin `id`, la etiqueta manda:
 * guardar otra vez «Nexa se atrasa» reemplaza el que había.
 */
export async function saveScenario(
  db: SupabaseClient,
  input: { id?: string; label: string; adjustments: ScenarioAdjustment[]; userId: string },
): Promise<Scenario> {
  const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!label) throw new Error('El escenario necesita un nombre.');
  const parsed = scenarioAdjustmentsSchema.safeParse(input.adjustments);
  if (!parsed.success) throw new Error('Algún ajuste del escenario no tiene la forma esperada.');
  if (!parsed.data.length) throw new Error('El escenario necesita al menos un ajuste.');
  const adjustments = parsed.data;
  const key = labelKey(label);
  const now = new Date().toISOString();

  let targetId = input.id ?? null;
  if (targetId) {
    const existing = await getScenario(db, targetId);
    if (!existing) throw new Error('No encontré ese escenario.');
  } else {
    const { data, error } = await db
      .from('ledger_scenarios')
      .select('id')
      .eq('label_key', key)
      .maybeSingle();
    if (error) throw error;
    targetId = (data as { id: string } | null)?.id ?? null;
  }

  if (targetId) {
    const { error } = await db
      .from('ledger_scenarios')
      .update({ label, label_key: key, adjustments, updated_by: input.userId, updated_at: now })
      .eq('id', targetId);
    if (error) {
      if ((error as { code?: string }).code === '23505')
        throw new Error(`Ya hay otro escenario que se llama «${label}».`);
      throw error;
    }
    return { id: targetId, label, adjustments };
  }
  const id = randomUUID();
  const { error } = await db.from('ledger_scenarios').insert({
    id,
    label,
    label_key: key,
    adjustments,
    created_by: input.userId,
    updated_by: input.userId,
    created_at: now,
    updated_at: now,
  });
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new Error(`Ya hay un escenario que se llama «${label}»; vuelve a intentarlo.`);
    throw error;
  }
  return { id, label, adjustments };
}

export async function deleteScenario(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('ledger_scenarios').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Lo que se repite: declarado, confirmado, ignorado
// ---------------------------------------------------------------------------

export type RecurringStatus = 'declared' | 'confirmed' | 'ignored';
export type RecurringDecision = RecurringFlow & {
  status: RecurringStatus;
  detectedKey?: string | null;
};

interface RecurringRow {
  id: string;
  status: RecurringStatus;
  detected_key: string | null;
  label: string;
  direction: LedgerDirection;
  amount: number | string;
  currency: string;
  every: 'week' | 'month';
  anchor: number;
  category: string | null;
  counterparty_name: string | null;
  created_at: string;
  updated_at: string;
}

const RECURRING_COLUMNS =
  'id, status, detected_key, label, direction, amount, currency, every, anchor, category, counterparty_name, created_at, updated_at';

function rowToDecision(row: RecurringRow): RecurringDecision {
  return {
    id: row.id,
    label: row.label,
    direction: row.direction,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    every: row.every,
    anchor: row.anchor,
    category: row.category,
    counterpartyName: row.counterparty_name,
    origin: row.status === 'declared' ? 'declared' : 'detected',
    detectedKey: row.detected_key,
    status: row.status,
  };
}

/** Lo declarado y las decisiones sobre lo detectado, lo más reciente primero. */
export async function listRecurringDecisions(db: SupabaseClient): Promise<RecurringDecision[]> {
  const { data, error } = await db
    .from('ledger_recurring')
    .select(RECURRING_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as RecurringRow[]).map(rowToDecision);
}

function cleanFlow(input: Omit<RecurringFlow, 'id' | 'origin'>) {
  const label = input.label.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!label) throw new Error('Dime qué es lo que se repite («Arriendo de la bodega»).');
  if (!(input.amount > 0) || !Number.isFinite(input.amount))
    throw new Error('El valor tiene que ser un número positivo.');
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('La moneda tiene que ser de tres letras.');
  const anchor = Math.round(input.anchor);
  if (input.every === 'month' && (anchor < 1 || anchor > 31))
    throw new Error('El día del mes tiene que estar entre 1 y 31.');
  if (input.every === 'week' && (anchor < 1 || anchor > 7))
    throw new Error('El día de la semana va de 1 (lunes) a 7 (domingo).');
  const category = input.category ? toCategoryKey(input.category) : null;
  return {
    label,
    direction: input.direction,
    amount: round2(input.amount),
    currency,
    every: input.every,
    anchor,
    category,
    counterparty_name: input.counterpartyName?.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
  };
}

/**
 * Declarar algo que se repite. Se suma a lo detectado; si habla de lo mismo
 * que un detectado (misma contraparte o categoría, día parecido) o trae su
 * `detectedKey`, lo reemplaza en la proyección.
 */
export async function declareRecurring(
  db: SupabaseClient,
  input: Omit<RecurringFlow, 'id' | 'origin'> & { userId: string },
): Promise<RecurringFlow> {
  const fields = cleanFlow(input);
  const now = new Date().toISOString();
  const detectedKey = input.detectedKey?.trim() || null;
  if (detectedKey) {
    // Corregir un detectado: una sola decisión por llave, así que se reemplaza.
    const { data, error } = await db
      .from('ledger_recurring')
      .select('id')
      .eq('detected_key', detectedKey)
      .maybeSingle();
    if (error) throw error;
    const existing = (data as { id: string } | null)?.id ?? null;
    if (existing) {
      const { error: e } = await db
        .from('ledger_recurring')
        .update({ ...fields, status: 'declared', updated_by: input.userId, updated_at: now })
        .eq('id', existing);
      if (e) throw e;
      return rowToFlow(existing, fields, detectedKey);
    }
  }
  const id = randomUUID();
  const { error } = await db.from('ledger_recurring').insert({
    id,
    ...fields,
    status: 'declared',
    detected_key: detectedKey,
    created_by: input.userId,
    updated_by: input.userId,
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  return rowToFlow(id, fields, detectedKey);
}

function rowToFlow(
  id: string,
  f: ReturnType<typeof cleanFlow>,
  detectedKey: string | null,
): RecurringFlow {
  return {
    id,
    label: f.label,
    direction: f.direction,
    amount: f.amount,
    currency: f.currency,
    every: f.every,
    anchor: f.anchor,
    category: f.category,
    counterpartyName: f.counterparty_name,
    origin: 'declared',
    detectedKey,
  };
}

/** Quitar algo declarado (o una decisión): vuelve a mandar lo detectado. */
export async function deleteRecurring(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('ledger_recurring').delete().eq('id', id);
  if (error) throw error;
}

/** Los recurrentes que el motor detecta hoy en el libro, con su `detectedKey`. */
export async function detectedRecurring(
  db: SupabaseClient,
  opts: { today: string; currency?: string },
): Promise<RecurringFlow[]> {
  const ledger = await loadLedger(db, {
    today: opts.today,
    historyDays: 400,
    currency: opts.currency ?? null,
  });
  return detectRecurring(ledger.movements, opts.today);
}

/**
 * Confirmar o ignorar un recurrente detectado. Se guarda con los campos que
 * tiene hoy, para mostrarlo aunque mañana ya no se detecte.
 */
export async function decideDetectedRecurring(
  db: SupabaseClient,
  input: { detectedKey: string; status: 'confirmed' | 'ignored'; userId: string; today?: string },
): Promise<void> {
  const key = input.detectedKey.trim();
  if (!key) throw new Error('Falta cuál movimiento que se repite.');
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('ledger_recurring')
    .select('id')
    .eq('detected_key', key)
    .maybeSingle();
  if (error) throw error;
  const existing = (data as { id: string } | null)?.id ?? null;
  if (existing) {
    const { error: e } = await db
      .from('ledger_recurring')
      .update({ status: input.status, updated_by: input.userId, updated_at: now })
      .eq('id', existing);
    if (e) throw e;
    return;
  }
  const today = input.today ?? now.slice(0, 10);
  const flow = (await detectedRecurring(db, { today })).find((f) => f.detectedKey === key);
  if (!flow)
    throw new Error(
      'Ya no encuentro ese movimiento que se repite en el historial; puede que haya dejado de repetirse.',
    );
  const fields = cleanFlow(flow);
  const { error: e } = await db.from('ledger_recurring').insert({
    id: randomUUID(),
    ...fields,
    status: input.status,
    detected_key: key,
    created_by: input.userId,
    updated_by: input.userId,
    created_at: now,
    updated_at: now,
  });
  if (e) throw e;
}

// ---------------------------------------------------------------------------
// La caja mínima de la empresa (migración 0175)
// ---------------------------------------------------------------------------

export interface LedgerSettings {
  /** La caja con la que la empresa está tranquila. `null` = sin decidir. */
  minimumCash: number | null;
  currency: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

const EMPTY_SETTINGS: LedgerSettings = {
  minimumCash: null,
  currency: 'COP',
  updatedBy: null,
  updatedAt: null,
};

interface SettingsRow {
  minimum_cash: number | string | null;
  currency: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

const SETTINGS_COLUMNS = 'minimum_cash, currency, updated_by, updated_at';

function rowToSettings(row: SettingsRow | null): LedgerSettings {
  if (!row) return { ...EMPTY_SETTINGS };
  const min = num(row.minimum_cash);
  return {
    minimumCash: min !== null && min >= 0 ? min : null,
    currency: (row.currency ?? 'COP').toUpperCase(),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** La caja mínima guardada de la empresa. Sin fila, nada decidido. */
export async function getLedgerSettings(db: SupabaseClient): Promise<LedgerSettings> {
  const { data, error } = await db.from('ledger_settings').select(SETTINGS_COLUMNS).maybeSingle();
  if (error) throw error;
  return rowToSettings((data as SettingsRow | null) ?? null);
}

/**
 * Guardar (o quitar, con `null`) la caja mínima de la empresa.
 *
 * LA REGLA VIVE AQUÍ, no en la pantalla ni en la herramienta: sólo quien
 * administra la empresa o es su dueño (`isCompanyManager`) la cambia, porque
 * es una decisión de la empresa que mueve el centro de mando, el pulso y la
 * revisión semanal de todos. La herramienta del chat y la acción de /finance
 * llaman esto; ninguna puede saltarse la revisión.
 */
export async function saveLedgerSettings(
  db: SupabaseClient,
  input: { minimumCash: number | null; currency?: string; userId: string },
): Promise<LedgerSettings> {
  if (!(await isCompanyManager(db, input.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede fijar la caja mínima.',
    );
  const currency = (input.currency ?? 'COP').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ValidationError('La moneda tiene que ser de tres letras.');
  const min = input.minimumCash;
  if (min !== null && (!Number.isFinite(min) || min < 0 || min > 1e13))
    throw new ValidationError('La caja mínima tiene que ser un valor de cero en adelante.');
  const { data, error } = await db
    .from('ledger_settings')
    .upsert(
      {
        minimum_cash: min === null ? null : round2(min),
        currency,
        updated_by: input.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' },
    )
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return rowToSettings(data as SettingsRow);
}

/**
 * La caja mínima que vale para una proyección: la que se pidió, si se pidió; si
 * no, la guardada de la empresa en ESA moneda (un piso en pesos no dice nada de
 * una caja en dólares); si no, `null` y el motor usa un mes de gastos fijos.
 */
export function effectiveMinimumCash(
  explicit: number | null | undefined,
  settings: Pick<LedgerSettings, 'minimumCash' | 'currency'>,
  currency: string,
): number | null {
  if (explicit !== null && explicit !== undefined) return explicit;
  if (settings.minimumCash === null) return null;
  return settings.currency === currency.trim().toUpperCase() ? settings.minimumCash : null;
}

// ---------------------------------------------------------------------------
// La proyección, lista para usar
// ---------------------------------------------------------------------------

export interface ForecastOptions {
  /** Hoy, día de Bogotá. */
  today: string;
  /** Por defecto, COP. */
  currency?: string;
  /** Un escenario guardado para comparar contra la base. */
  scenarioId?: string | null;
  /** Un escenario armado en el momento (el chat); manda sobre `scenarioId`. */
  scenario?: Scenario | null;
  /** Por defecto, sí. */
  includeEstimatedSales?: boolean;
  /**
   * El piso contra el que se mide la caja. Sin él (o `null`), la caja mínima
   * guardada de la empresa (`ledger_settings`); sin ésa, un mes de gastos fijos.
   */
  minimumCash?: number | null;
  horizonWeeks?: number;
}

/**
 * La entrada del motor con el libro y los planes: cuentas y movimientos de la
 * moneda, lo declarado, lo confirmado e ignorado, y el escenario si se pidió.
 */
export async function buildForecastInput(
  db: SupabaseClient,
  opts: ForecastOptions,
): Promise<ForecastInput> {
  const currency = (opts.currency ?? 'COP').trim().toUpperCase();
  const explicitMinimum = opts.minimumCash ?? null;
  const [ledger, decisions, saved, settings] = await Promise.all([
    loadLedger(db, { today: opts.today, historyDays: 400, currency }),
    listRecurringDecisions(db),
    !opts.scenario && opts.scenarioId ? getScenario(db, opts.scenarioId) : Promise.resolve(null),
    explicitMinimum === null ? getLedgerSettings(db) : Promise.resolve(EMPTY_SETTINGS),
  ]);
  if (!opts.scenario && opts.scenarioId && !saved) throw new Error('No encontré ese escenario.');
  const keysOf = (status: RecurringStatus) =>
    decisions
      .filter((d) => d.status === status && d.detectedKey)
      .map((d) => d.detectedKey as string);
  return {
    asOf: opts.today,
    currency,
    accounts: ledger.accounts,
    movements: ledger.movements,
    recurring: decisions
      .filter((d) => d.status === 'declared' && d.currency === currency)
      .map(({ status: _s, ...flow }) => flow),
    ignoredRecurring: keysOf('ignored'),
    confirmedRecurring: keysOf('confirmed'),
    scenario: opts.scenario ?? saved ?? null,
    includeEstimatedSales: opts.includeEstimatedSales ?? true,
    minimumCash: effectiveMinimumCash(explicitMinimum, settings, currency),
    ...(opts.horizonWeeks ? { horizonWeeks: opts.horizonWeeks } : {}),
  };
}

export interface ForecastRun {
  base: ForecastResult;
  scenario: ForecastResult | null;
  comparison: ReturnType<typeof compareScenarios> | null;
}

/** La base y, si se pidió un escenario, el escenario y la comparación. */
export async function runForecast(db: SupabaseClient, opts: ForecastOptions): Promise<ForecastRun> {
  const input = await buildForecastInput(db, opts);
  const base = forecast({ ...input, scenario: null });
  if (!input.scenario) return { base, scenario: null, comparison: null };
  const scenario = forecast(input);
  return { base, scenario, comparison: compareScenarios(base, scenario) };
}

// ---------------------------------------------------------------------------
// Pérdidas y ganancias por mes (de caja)
// ---------------------------------------------------------------------------

export interface PnlMonth {
  /** AAAA-MM. */
  month: string;
  sales: number;
  otherIncome: number;
  expenses: number;
  /** Gastos por categoría (clave del libro; 'sin_categoria' lo que falta). */
  byCategory: Record<string, number>;
  margin: number;
}

/**
 * Ventas, otros ingresos, gastos por categoría y margen de cada uno de los
 * últimos `months` meses (contando el actual), de lo ya liquidado: es caja,
 * no contabilidad. Ventas = ingresos de la categoría ventas y los que aún no
 * tienen categoría (casi siempre abonos de clientes); otros ingresos = el
 * resto. Las devoluciones y reintegros restan. Con `includePayroll = false`,
 * la nómina se dobla en un solo total `'nomina (confidencial)'`.
 */
export async function monthlyPnl(
  db: SupabaseClient,
  opts: { months: number; currency?: string; today: string; includePayroll: boolean },
): Promise<PnlMonth[]> {
  const months = Math.min(Math.max(Math.round(opts.months), 1), 36);
  const currency = (opts.currency ?? 'COP').trim().toUpperCase();
  const keys: string[] = [];
  let cursor = `${opts.today.slice(0, 7)}-01`;
  for (let i = 0; i < months; i++) {
    keys.unshift(cursor.slice(0, 7));
    cursor = `${addDays(cursor, -1).slice(0, 7)}-01`;
  }
  const from = `${keys[0]}-01`;
  const { rows } = await listMovements(db, {
    from,
    to: opts.today,
    currency,
    status: ['settled'],
    kinds: ['income', 'expense'],
  });
  const byMonth = new Map<string, PnlMonth>(
    keys.map((month) => [
      month,
      { month, sales: 0, otherIncome: 0, expenses: 0, byCategory: {}, margin: 0 },
    ]),
  );
  for (const r of rows) {
    const bucket = byMonth.get(monthOf(r.date));
    if (!bucket) continue;
    const amount = num(r.amount) ?? 0;
    if (r.kind === 'income') {
      const signed = r.direction === 'in' ? amount : -amount;
      if (!r.category || r.category === 'ventas') bucket.sales += signed;
      else bucket.otherIncome += signed;
    } else {
      const signed = r.direction === 'out' ? amount : -amount;
      bucket.expenses += signed;
      let key = r.category ?? 'sin_categoria';
      if (!opts.includePayroll && isPayrollCategory(key)) key = PAYROLL_CONFIDENTIAL_KEY;
      bucket.byCategory[key] = (bucket.byCategory[key] ?? 0) + signed;
    }
  }
  return [...byMonth.values()].map((b) => ({
    month: b.month,
    sales: round2(b.sales),
    otherIncome: round2(b.otherIncome),
    expenses: round2(b.expenses),
    byCategory: Object.fromEntries(
      Object.entries(b.byCategory).map(([k, v]) => [k, round2(v)] as const),
    ),
    margin: round2(b.sales + b.otherIncome - b.expenses),
  }));
}
