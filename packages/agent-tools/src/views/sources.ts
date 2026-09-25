import type { SupabaseClient } from '@supabase/supabase-js';
import { STATUS_LABEL as CLIENT_STATUS_LABEL, SERVICE_LABEL, fullNit } from '../clients/shape';
import { listClients } from '../clients/store';
import {
  COMMITMENT_KINDS,
  KIND_LABEL as COMMITMENT_KIND_LABEL,
  COMMITMENT_STATES,
  STATE_LABEL as COMMITMENT_STATE_LABEL,
  type CommitmentKind,
  bogotaToday,
  daysBetween,
  deriveState,
} from '../commitments/shape';
import {
  CADENCES,
  CADENCE_LABEL,
  STATUS_LABEL as GOAL_STATUS_LABEL,
  READING_STATUSES,
  type ReadingStatus,
} from '../goals/shape';
import { listGoals } from '../goals/store';
import { type ManagementState, managementStateLabels, managementStates } from '../management/shape';
import {
  COUNTED_STATES,
  PAYMENT_KINDS,
  KIND_LABEL as PAYMENT_KIND_LABEL,
  STATE_LABEL as PAYMENT_STATE_LABEL,
  type PaymentKind,
  signedAmount,
} from '../payments/shape';
import { listPayments, num } from '../payments/store';
import type { TrackerField } from '../trackers/schema';
import { type ViewRow, todayIn } from './compute';
import { type ViewSpec, trackersOf } from './spec';

/**
 * LAS TABLAS DE LA PLATAFORMA COMO FUENTES DE UNA VISTA.
 *
 * Una vista nació leyendo sólo las tablas que el espacio se inventa (0115).
 * Pero lo que la gente más quiere ver en un tablero —«cuánto vendimos este
 * mes», «qué se vence», «quién nos debe»— ya vive en tablas de Cortex con sus
 * propias reglas: facturas confirmadas, pagos reconciliados, clientes con NIT,
 * vencimientos con su estado del día. Copiarlo a una tabla inventada sería una
 * segunda verdad que envejece. Este registro las expone TAL COMO ESTÁN, en
 * sólo lectura, con la misma forma de campo que una tabla inventada
 * (`TrackerField`), para que `computeView` no tenga que saber de dónde vino
 * una fila.
 *
 * TRES REGLAS QUE ESTE ARCHIVO NO NEGOCIA:
 *
 *   1. Se lee con el handle del espacio y por los módulos dueños de cada tabla
 *      cuando tienen una función de lectura (`listClients`, `listPayments`,
 *      `listGoals`), con sus mismos filtros de verdad: sólo facturas
 *      CONFIRMADAS y marcadas como por cobrar, sólo pagos que cuentan
 *      (reportados o confirmados; uno en disputa no está en ninguna cifra),
 *      sólo vencimientos confirmados. Una vista no es una puerta trasera para
 *      ver lo que la pantalla del módulo se niega a sumar.
 *
 *   2. El dinero de un campo `money` es SIEMPRE pesos. `money` se pinta como
 *      COP, así que una factura en dólares no entra en él: su importe va a un
 *      campo numérico aparte («Total en otra moneda») junto a su moneda.
 *      Sumar 3.000 USD a 12.000.000 COP produce 12.003.000 de nada (ver
 *      payments/shape.ts), y un tablero es justo donde esa suma pasaría
 *      desapercibida.
 *
 *   3. Cada fuente declara su `sensitivity`. Las que nombran a gente del
 *      equipo o su trabajo interno (compromisos entre compañeros, asuntos de
 *      Gerencia, la prospección comercial) son `internal`: una vista que las
 *      usa no se comparte por enlace ni con contraseña (`setViewAccess`), y si
 *      aun así una llegara a la página pública, `loadViewSources` ni la lee.
 *      Las `shareable` muestran datos de la empresa con clientes y terceros,
 *      que es exactamente lo que alguien decide mostrar al abrir un enlace.
 *
 * Lo que un campo NO expone también es decisión: el responsable de un cliente,
 * los teléfonos, las notas y el detalle de un vencimiento se quedan fuera de
 * las fuentes compartibles; los correos de contacto de un prospecto no salen
 * por ninguna.
 */

export type SourceSensitivity = 'shareable' | 'internal';

export interface PlatformSourceRead {
  rows: ViewRow[];
  /** True cuando hay más filas que las leídas. */
  truncated: boolean;
}

export interface PlatformSource {
  /** `cortex.<nombre>`: nunca choca con el slug de una tabla (spec.ts). */
  id: string;
  name: string;
  description: string;
  sensitivity: SourceSensitivity;
  fields: TrackerField[];
  /** Lee hasta `cap` filas con el handle del espacio. */
  read(db: SupabaseClient, cap: number, today: string): Promise<PlatformSourceRead>;
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

const field = (
  key: string,
  label: string,
  type: TrackerField['type'],
  options?: string[],
): TrackerField => ({ key, label, type, required: false, ...(options ? { options } : {}) });

type Values = Record<string, string | number>;

/** Un hueco se queda hueco: ni `null` ni cadena vacía viajan como valor. */
function put(values: Values, key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (typeof value === 'string' && value.trim() === '') return;
  values[key] = typeof value === 'string' ? value.trim() : value;
}

/** El día de Bogotá de un instante; una fecha ya en AAAA-MM-DD pasa tal cual. */
function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

function row(
  id: string,
  label: string,
  values: Values,
  createdAt: string | null | undefined,
  updatedAt?: string | null,
): ViewRow {
  const created = createdAt ?? new Date(0).toISOString();
  return { id, label, values, created_at: created, updated_at: updatedAt ?? created };
}

/**
 * `.in()` en tandas. Un `.in('id', [...])` con mil UUID es una URL de cuarenta
 * mil caracteres que el proxy corta antes de que PostgREST la vea; cien por
 * tanda cabe con holgura y sigue siendo una consulta por cada cien filas.
 */
const IN_CHUNK = 100;

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK)
    out.push(...(await fetch(ids.slice(i, i + IN_CHUNK))));
  return out;
}

const unique = (ids: Array<string | null | undefined>) => [
  ...new Set(ids.filter((id): id is string => Boolean(id))),
];

/** Nombres de clientes por id. Un cliente que no se ve deja un hueco, no un id. */
async function clientNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const rows = await inChunks(unique(ids), async (chunk) => {
    const { data, error } = await db.from('clients').select('id, name').in('id', chunk);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string }>;
  });
  return new Map(rows.map((c) => [c.id, c.name]));
}

/** Nombres de personas del equipo. Sólo lo usan fuentes `internal`. */
async function userNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const rows = await inChunks(unique(ids), async (chunk) => {
    const { data, error } = await db.from('users').select('id, name, email').in('id', chunk);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string | null; email: string }>;
  });
  return new Map(rows.map((u) => [u.id, u.name?.trim() || u.email]));
}

const COP = 'COP';

// ---------------------------------------------------------------------------
// Ventas: las facturas que la empresa emitió, con lo cobrado y lo que falta
// ---------------------------------------------------------------------------

/**
 * «VENTAS» EN CORTEX SON FACTURAS DE VENTA CONFIRMADAS.
 *
 * No hay una tabla de ventas ni de negocios propia (los negocios de HubSpot se
 * consultan en vivo y no se guardan). Lo más cercano, y lo que Finanzas ya
 * usa para la cartera, son las facturas leídas de documentos que una persona
 * confirmó y clasificó como por cobrar (0076 + 0143). Los mismos tres filtros
 * que `receivables()`: `doc_type = invoice`, `financial_role = receivable`,
 * `review_state = confirmed`. Una factura sin revisar no es una venta todavía.
 *
 * Lo cobrado de cada factura son los pagos que cuentan, enlazados a ESA
 * factura y en SU moneda — la misma disciplina que la cartera: un pago sin
 * factura no se reparte entre las abiertas.
 */
const VENTA_ESTADOS = ['Por cobrar', 'Vencida', 'Pagada'];

const ventas: PlatformSource = {
  id: 'cortex.ventas',
  name: 'Ventas (facturas emitidas)',
  description:
    'Facturas de venta confirmadas y clasificadas como por cobrar, con lo cobrado, el saldo y si están vencidas. Es la base de la cartera.',
  sensitivity: 'shareable',
  fields: [
    field('numero', 'Número', 'text'),
    field('cliente', 'Cliente', 'text'),
    field('nit', 'NIT', 'text'),
    field('emitida', 'Emitida', 'date'),
    field('vence', 'Vence', 'date'),
    field('total', 'Total (COP)', 'money'),
    field('iva', 'IVA (COP)', 'money'),
    field('pagado', 'Cobrado (COP)', 'money'),
    field('saldo', 'Saldo (COP)', 'money'),
    field('estado', 'Estado', 'select', VENTA_ESTADOS),
    field('dias_mora', 'Días vencida', 'number'),
    field('moneda', 'Moneda', 'text'),
    field('total_otra_moneda', 'Total en otra moneda', 'number'),
  ],
  async read(db, cap, today) {
    const { data, error } = await db
      .from('document_extractions')
      .select(
        'id, doc_number, client_id, counterparty_name, counterparty_nit, total_amount, tax_amount, currency, issued_on, due_on, created_at, updated_at',
      )
      .eq('review_state', 'confirmed')
      .eq('doc_type', 'invoice')
      .eq('financial_role', 'receivable')
      .order('issued_on', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      doc_number: string | null;
      client_id: string | null;
      counterparty_name: string | null;
      counterparty_nit: string | null;
      total_amount: number | string | null;
      tax_amount: number | string | null;
      currency: string | null;
      issued_on: string | null;
      due_on: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const invoices = all.slice(0, cap);

    const payments = await inChunks(
      invoices.map((i) => i.id),
      async (chunk) => {
        const read = await db
          .from('payments')
          .select('extraction_id, kind, amount, currency')
          .in('state', [...COUNTED_STATES])
          .in('extraction_id', chunk);
        if (read.error) throw read.error;
        return (read.data ?? []) as Array<{
          extraction_id: string;
          kind: PaymentKind;
          amount: number | string;
          currency: string;
        }>;
      },
    );
    const paid = new Map<string, number>();
    for (const p of payments) {
      const key = `${p.extraction_id}\u0000${p.currency}`;
      paid.set(key, (paid.get(key) ?? 0) + signedAmount(p.kind, num(p.amount) ?? 0));
    }
    const names = await clientNames(
      db,
      invoices.map((i) => i.client_id ?? ''),
    );

    const rows = invoices.map((inv) => {
      const values: Values = {};
      const total = num(inv.total_amount);
      const cobrado = inv.currency ? (paid.get(`${inv.id}\u0000${inv.currency}`) ?? 0) : 0;
      const saldo = total === null ? null : total - cobrado;
      const open = saldo !== null && saldo > 0.005;
      const late = open && inv.due_on ? daysBetween(inv.due_on, today) : null;
      put(values, 'numero', inv.doc_number);
      put(
        values,
        'cliente',
        (inv.client_id ? names.get(inv.client_id) : null) ?? inv.counterparty_name,
      );
      put(values, 'nit', inv.counterparty_nit);
      put(values, 'emitida', inv.issued_on);
      put(values, 'vence', inv.due_on);
      put(values, 'moneda', inv.currency ?? 'Sin moneda');
      if (inv.currency === COP) {
        put(values, 'total', total);
        put(values, 'iva', num(inv.tax_amount));
        put(values, 'pagado', cobrado);
        put(values, 'saldo', saldo);
      } else if (inv.currency) {
        put(values, 'total_otra_moneda', total);
      }
      if (saldo !== null && inv.currency)
        put(
          values,
          'estado',
          !open ? 'Pagada' : late !== null && late > 0 ? 'Vencida' : 'Por cobrar',
        );
      if (late !== null && late > 0) put(values, 'dias_mora', late);
      return row(
        inv.id,
        inv.doc_number ?? 'Factura sin número',
        values,
        inv.created_at,
        inv.updated_at,
      );
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Pagos recibidos
// ---------------------------------------------------------------------------

/** `listPayments` no lee más de mil filas; es su tope y se respeta. */
const PAYMENTS_CAP = 1000;

const pagos: PlatformSource = {
  id: 'cortex.pagos',
  name: 'Pagos recibidos',
  description:
    'Abonos, anulaciones y ajustes que cuentan (reportados o confirmados). Los pagos en disputa o descartados no están, igual que en la cartera.',
  sensitivity: 'shareable',
  fields: [
    field('fecha', 'Fecha de pago', 'date'),
    field('cliente', 'Cliente', 'text'),
    field('factura', 'Factura', 'text'),
    field(
      'tipo',
      'Tipo',
      'select',
      PAYMENT_KINDS.map((k) => PAYMENT_KIND_LABEL[k]),
    ),
    field(
      'estado',
      'Estado',
      'select',
      COUNTED_STATES.map((s) => PAYMENT_STATE_LABEL[s]),
    ),
    field('valor', 'Valor (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('valor_otra_moneda', 'Valor en otra moneda', 'number'),
    field('fuentes', 'Fuentes que lo confirman', 'number'),
  ],
  async read(db, cap) {
    const limit = Math.min(cap, PAYMENTS_CAP);
    const list = await listPayments(db, { state: [...COUNTED_STATES], limit });
    const names = await clientNames(
      db,
      list.map((p) => p.client_id ?? ''),
    );
    const rows = list.map((p) => {
      const values: Values = {};
      // Una anulación resta: el signo lo pone `kind`, en un solo sitio.
      const signed = signedAmount(p.kind, num(p.amount) ?? 0);
      const client = p.client_id ? (names.get(p.client_id) ?? null) : null;
      put(values, 'fecha', p.paid_on);
      put(values, 'cliente', client);
      put(values, 'factura', p.invoice_number);
      put(values, 'tipo', PAYMENT_KIND_LABEL[p.kind]);
      put(values, 'estado', PAYMENT_STATE_LABEL[p.state]);
      put(values, 'moneda', p.currency);
      if (p.currency === COP) put(values, 'valor', signed);
      else put(values, 'valor_otra_moneda', signed);
      put(values, 'fuentes', p.source_count);
      return row(
        p.id,
        client ?? p.invoice_number ?? 'Pago sin cliente',
        values,
        p.created_at,
        p.updated_at,
      );
    });
    // Mil filas exactas puede ser «justo mil» o «mil y más»: se dice parcial.
    return { rows, truncated: list.length >= limit };
  },
};

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

const clientes: PlatformSource = {
  id: 'cortex.clientes',
  name: 'Clientes',
  description:
    'Los clientes registrados con su NIT, estado, ciudad, servicios, plazo de pago y cupo. Sin responsable interno, teléfonos ni notas.',
  sensitivity: 'shareable',
  fields: [
    field('razon_social', 'Razón social', 'text'),
    field('nit', 'NIT', 'text'),
    field('estado', 'Estado', 'select', Object.values(CLIENT_STATUS_LABEL)),
    field('ciudad', 'Ciudad', 'text'),
    field('departamento', 'Departamento', 'text'),
    field('servicios', 'Servicios', 'text'),
    field('plazo_pago', 'Plazo de pago (días)', 'number'),
    field('cupo', 'Cupo de crédito (COP)', 'money'),
    field('cliente_desde', 'Cliente desde', 'date'),
  ],
  async read(db, cap) {
    const all = await listClients(db, { limit: cap + 1 });
    const rows = all.slice(0, cap).map((c) => {
      const values: Values = {};
      put(values, 'razon_social', c.legal_name);
      put(values, 'nit', fullNit(c.tax_id));
      put(values, 'estado', CLIENT_STATUS_LABEL[c.status] ?? c.status);
      put(values, 'ciudad', c.city);
      put(values, 'departamento', c.department);
      put(
        values,
        'servicios',
        (c.services ?? [])
          .map((s) => SERVICE_LABEL[s as keyof typeof SERVICE_LABEL] ?? s)
          .join(', '),
      );
      put(values, 'plazo_pago', c.payment_terms_days);
      put(values, 'cupo', num(c.credit_limit_cop));
      put(values, 'cliente_desde', dayOf(c.since));
      return row(c.id, c.name, values, c.created_at, c.updated_at);
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Vencimientos y compromisos internos: la misma tabla, dos puertas
// ---------------------------------------------------------------------------

/**
 * La 0097 metió las promesas entre compañeros en la misma tabla que el SOAT
 * (ver commitments/shape.ts, `isInternalKind`). Aquí se separan otra vez, y
 * por la razón de siempre: un vencimiento con un tercero es un dato de la
 * empresa que puede mostrarse; «Ana quedó de mandar el informe el viernes» es
 * trabajo interno de una persona con nombre y no sale por un enlace.
 *
 * El estado es el del DÍA (`deriveState`), no la columna que el vigilante
 * refresca de noche: entre dos corridas, la fecha es la verdad.
 */
const COMMITMENT_READ =
  'id, title, detail, kind, counterparty, amount_cop, due_on, notice_days, state, met_at, owner_user_id, created_at, updated_at';

interface CommitmentLite {
  id: string;
  title: string;
  detail: string | null;
  kind: CommitmentKind;
  counterparty: string | null;
  amount_cop: number | string | null;
  due_on: string;
  notice_days: number | null;
  state: string | null;
  met_at: string | null;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

async function readCommitments(
  db: SupabaseClient,
  cap: number,
  internal: boolean,
): Promise<{ list: CommitmentLite[]; truncated: boolean }> {
  let q = db.from('commitments').select(COMMITMENT_READ).eq('review_state', 'confirmed');
  q = internal ? q.eq('kind', 'internal') : q.not('kind', 'in', '(internal)');
  const { data, error } = await q.order('due_on', { ascending: false }).limit(cap + 1);
  if (error) throw error;
  const all = (data ?? []) as CommitmentLite[];
  return { list: all.slice(0, cap), truncated: all.length > cap };
}

const STATE_OPTIONS = COMMITMENT_STATES.map((s) => COMMITMENT_STATE_LABEL[s]);

const vencimientos: PlatformSource = {
  id: 'cortex.vencimientos',
  name: 'Vencimientos',
  description:
    'Fechas que la empresa le debe a terceros (SOAT, tecnomecánica, contratos, pólizas, aduana, pagos…), confirmadas, con su estado de hoy.',
  sensitivity: 'shareable',
  fields: [
    field(
      'tipo',
      'Tipo',
      'select',
      COMMITMENT_KINDS.filter((k) => k !== 'internal').map((k) => COMMITMENT_KIND_LABEL[k]),
    ),
    field('contraparte', 'Con quién', 'text'),
    field('vence', 'Vence', 'date'),
    field('estado', 'Estado', 'select', STATE_OPTIONS),
    field('dias', 'Días para vencer', 'number'),
    field('valor', 'Valor (COP)', 'money'),
    field('cumplido', 'Cumplido el', 'date'),
  ],
  async read(db, cap, today) {
    const { list, truncated } = await readCommitments(db, cap, false);
    const rows = list.map((c) => {
      const values: Values = {};
      const state = deriveState(c, today);
      put(values, 'tipo', COMMITMENT_KIND_LABEL[c.kind] ?? c.kind);
      put(values, 'contraparte', c.counterparty);
      put(values, 'vence', c.due_on);
      put(values, 'estado', COMMITMENT_STATE_LABEL[state]);
      if (state !== 'met' && state !== 'dropped') put(values, 'dias', daysBetween(today, c.due_on));
      put(values, 'valor', num(c.amount_cop));
      put(values, 'cumplido', dayOf(c.met_at));
      return row(c.id, c.title, values, c.created_at, c.updated_at);
    });
    return { rows, truncated };
  },
};

const compromisos: PlatformSource = {
  id: 'cortex.compromisos',
  name: 'Compromisos internos',
  description:
    'Lo que alguien del equipo quedó de hacer para otro, con responsable, fecha y estado de hoy. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('responsable', 'Responsable', 'text'),
    field('vence', 'Para cuándo', 'date'),
    field('estado', 'Estado', 'select', STATE_OPTIONS),
    field('dias', 'Días para vencer', 'number'),
    field('cumplido', 'Cumplido el', 'date'),
    field('detalle', 'Detalle', 'text'),
  ],
  async read(db, cap, today) {
    const { list, truncated } = await readCommitments(db, cap, true);
    const names = await userNames(
      db,
      list.map((c) => c.owner_user_id ?? ''),
    );
    const rows = list.map((c) => {
      const values: Values = {};
      const state = deriveState(c, today);
      put(values, 'responsable', c.owner_user_id ? names.get(c.owner_user_id) : null);
      put(values, 'vence', c.due_on);
      put(values, 'estado', COMMITMENT_STATE_LABEL[state]);
      if (state !== 'met' && state !== 'dropped') put(values, 'dias', daysBetween(today, c.due_on));
      put(values, 'cumplido', dayOf(c.met_at));
      put(values, 'detalle', c.detail?.slice(0, 300));
      return row(c.id, c.title, values, c.created_at, c.updated_at);
    });
    return { rows, truncated };
  },
};

// ---------------------------------------------------------------------------
// Metas: una fila por período medido
// ---------------------------------------------------------------------------

const UNIT_NAME: Record<string, string> = { percent: '%', days: 'Días', count: 'Cantidad' };

const metas: PlatformSource = {
  id: 'cortex.metas',
  name: 'Metas (lecturas por período)',
  description:
    'Cada período medido de cada meta activa: el valor, el objetivo y si se cumplió. Una fila por meta y período.',
  sensitivity: 'shareable',
  fields: [
    field('periodo', 'Período (inicio)', 'date'),
    field('valor', 'Valor', 'number'),
    field('objetivo', 'Objetivo', 'number'),
    field(
      'estado',
      'Resultado',
      'select',
      READING_STATUSES.map((s) => GOAL_STATUS_LABEL[s]),
    ),
    field(
      'cadencia',
      'Cadencia',
      'select',
      CADENCES.map((c) => CADENCE_LABEL[c]),
    ),
    field('unidad', 'Unidad', 'select', Object.values(UNIT_NAME)),
  ],
  async read(db, cap) {
    const goals = await listGoals(db, { state: 'active', limit: 100 });
    if (!goals.length) return { rows: [], truncated: false };
    const byId = new Map(goals.map((g) => [g.id, g]));
    const { data, error } = await db
      .from('goal_readings')
      .select('id, goal_id, period_start, value, unit, target_value, status, computed_at')
      .in(
        'goal_id',
        goals.map((g) => g.id),
      )
      .order('period_start', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      goal_id: string;
      period_start: string;
      value: number | string | null;
      unit: string;
      target_value: number | string;
      status: ReadingStatus;
      computed_at: string;
    }>;
    const rows = all.slice(0, cap).map((r) => {
      const goal = byId.get(r.goal_id);
      const values: Values = {};
      put(values, 'periodo', r.period_start);
      put(values, 'valor', num(r.value));
      put(values, 'objetivo', num(r.target_value));
      put(values, 'estado', GOAL_STATUS_LABEL[r.status] ?? r.status);
      put(values, 'cadencia', goal ? CADENCE_LABEL[goal.cadence] : null);
      put(values, 'unidad', UNIT_NAME[r.unit] ?? r.unit);
      return row(r.id, goal?.label ?? 'Meta', values, r.computed_at);
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Gerencia: los asuntos en gestión (0130)
// ---------------------------------------------------------------------------

const IMPACT_LABEL: Record<string, string> = { high: 'Alto', medium: 'Medio', low: 'Bajo' };

const gestion: PlatformSource = {
  id: 'cortex.gestion',
  name: 'Asuntos de Gerencia',
  description:
    'Los asuntos que Gerencia sigue: estado, impacto, responsable, fechas y siguiente paso. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field(
      'estado',
      'Estado',
      'select',
      managementStates.map((s) => managementStateLabels[s]),
    ),
    field('impacto', 'Impacto', 'select', Object.values(IMPACT_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('vence', 'Fecha límite', 'date'),
    field('revision', 'Próxima revisión', 'date'),
    field('siguiente_paso', 'Siguiente paso', 'text'),
    field('bloqueo', 'Bloqueo', 'text'),
  ],
  async read(db, cap) {
    const { data, error } = await db
      .from('management_cases')
      .select('id, data, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      data: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    }>;
    const list = all.slice(0, cap);
    // `data` es JSON guardado por versiones distintas del módulo: se lee campo
    // por campo y lo que no tenga la forma esperada se queda en blanco.
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const names = await userNames(
      db,
      list.map((c) => str(c.data?.ownerId) ?? ''),
    );
    const rows = list.map((c) => {
      const d = c.data ?? {};
      const values: Values = {};
      const state = str(d.state) as ManagementState | null;
      const owner = str(d.ownerId);
      put(values, 'estado', state ? (managementStateLabels[state] ?? state) : null);
      put(values, 'impacto', IMPACT_LABEL[str(d.impact) ?? ''] ?? null);
      put(values, 'responsable', owner ? names.get(owner) : null);
      put(values, 'vence', dayOf(str(d.dueOn)));
      put(values, 'revision', dayOf(str(d.nextReviewOn)));
      put(values, 'siguiente_paso', str(d.nextAction)?.slice(0, 300));
      put(values, 'bloqueo', str(d.blocker)?.slice(0, 300));
      return row(c.id, str(d.title) ?? 'Asunto sin título', values, c.created_at, c.updated_at);
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Prospectos: las oportunidades que encontró Crecimiento
// ---------------------------------------------------------------------------

const PROSPECT_STATUS: Record<string, string> = {
  new: 'Nueva',
  qualified: 'Calificada',
  rejected: 'Descartada',
  contacted: 'Contactada',
};

const prospectos: PlatformSource = {
  id: 'cortex.prospectos',
  name: 'Prospectos',
  description:
    'Oportunidades comerciales encontradas y su revisión (nueva, calificada, descartada, contactada). Sin datos de contacto. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('estado', 'Estado', 'select', Object.values(PROSPECT_STATUS)),
    field('industria', 'Industria', 'text'),
    field('senal', 'Señal de compra', 'text'),
    field('cargo', 'Cargo buscado', 'text'),
    field('region', 'Región', 'text'),
    field('fuente', 'Dónde se encontró', 'text'),
  ],
  async read(db, cap) {
    // Columnas nombradas: el contacto (nombre, correo, canal) nunca se lee aquí.
    const { data, error } = await db
      .from('growth_signals')
      .select(
        'id, company, candidate_name, role_title, industry, buying_signal, source, region, status, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<Record<string, string | null>>;
    const rows = all.slice(0, cap).map((s) => {
      const values: Values = {};
      put(values, 'estado', PROSPECT_STATUS[s.status ?? ''] ?? s.status);
      put(values, 'industria', s.industry);
      put(values, 'senal', s.buying_signal?.slice(0, 300));
      put(values, 'cargo', s.role_title);
      put(values, 'region', s.region);
      put(values, 'fuente', s.source);
      return row(
        String(s.id),
        s.company ?? s.candidate_name ?? 'Sin nombre',
        values,
        s.created_at,
        s.updated_at,
      );
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// El registro
// ---------------------------------------------------------------------------

export const PLATFORM_SOURCES: ReadonlyMap<string, PlatformSource> = new Map(
  [ventas, pagos, clientes, vencimientos, compromisos, metas, gestion, prospectos].map((s) => [
    s.id,
    s,
  ]),
);

export function platformSource(id: string): PlatformSource | null {
  return PLATFORM_SOURCES.get(id) ?? null;
}

/** Las fuentes internas que un spec usa, por nombre. Vacío = se puede compartir. */
export function internalSourcesOf(spec: ViewSpec): PlatformSource[] {
  return trackersOf(spec)
    .map((ref) => PLATFORM_SOURCES.get(ref))
    .filter((s): s is PlatformSource => s?.sensitivity === 'internal');
}

/** Lo que se le dice a quien intenta abrir la puerta de una vista con fuentes internas. */
export function internalShareRefusal(sources: PlatformSource[]): string {
  const names = sources.map((s) => `«${s.name}»`).join(', ');
  return `Esta vista usa información interna del equipo (${names}) y no se puede compartir por enlace ni con contraseña. Quita esos bloques, o haz otra vista sólo con datos que se puedan mostrar afuera.`;
}

/** Lee una fuente de la plataforma. `today` en Bogotá por defecto. */
export async function readPlatformSource(
  db: SupabaseClient,
  id: string,
  cap: number,
  today: string = bogotaToday(),
): Promise<PlatformSourceRead | null> {
  const source = PLATFORM_SOURCES.get(id);
  if (!source) return null;
  return source.read(db, Math.max(1, cap), today);
}

/**
 * Las fuentes en texto, para la descripción de las herramientas: id, nombre,
 * campos y si son internas. Se genera del registro para que el modelo nunca
 * lea una lista de campos distinta de la que `checkSpecAgainst` comprueba.
 */
export function platformSourcesGrammar(): string {
  return [...PLATFORM_SOURCES.values()]
    .map(
      (s) =>
        `- ${s.id} (${s.name}${s.sensitivity === 'internal' ? '; INTERNAL: a view using it cannot be shared by link' : ''}): ${s.fields
          .map((f) => `${f.key}:${f.type}${f.options ? `[${f.options.join('|')}]` : ''}`)
          .join(', ')}`,
    )
    .join('\n');
}
