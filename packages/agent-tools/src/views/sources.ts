import type { SupabaseClient } from '@supabase/supabase-js';
import { loadClientList } from '../clients/hub-read';
import {
  CLIENT_SOURCE_LABEL,
  STATUS_LABEL as CLIENT_STATUS_LABEL,
  SERVICE_LABEL,
  fullNit,
} from '../clients/shape';
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
import { cashRunwayWeeks } from '../ledger/forecast-explain';
import { monthlyPnl, runForecast } from '../ledger/plans';
import {
  PAYROLL_CONFIDENTIAL_KEY,
  PAYROLL_CONFIDENTIAL_LABEL,
  canSeePayrollDetail,
  isPayrollCategory,
} from '../ledger/privacy';
import {
  CATEGORY_LABEL as LEDGER_CATEGORY_LABEL,
  KIND_LABEL as LEDGER_KIND_LABEL,
  SOURCE_KIND_LABEL as LEDGER_SOURCE_LABEL,
  categoryLabel as ledgerCategoryLabel,
  num as ledgerNum,
} from '../ledger/shape';
import {
  listAccounts as listLedgerAccounts,
  listMovements as listLedgerMovements,
} from '../ledger/store';
import { type ManagementState, managementStateLabels, managementStates } from '../management/shape';
import { RECOVERY_TRIGGER_LABEL } from '../payments/recovered';
import { moneyRecovered } from '../payments/recovered-store';
import {
  COUNTED_STATES,
  PAYMENT_KINDS,
  KIND_LABEL as PAYMENT_KIND_LABEL,
  STATE_LABEL as PAYMENT_STATE_LABEL,
  type PaymentKind,
  signedAmount,
} from '../payments/shape';
import { listPayments, num, overdueReceivableInvoices } from '../payments/store';
import type { TrackerField } from '../trackers/schema';
import { equipoSource, trabajoSource } from '../work/view-sources';
import { type ViewRow, todayIn } from './compute';
import { type ViewSpec, isFeedSourceId, trackersOf } from './spec';

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
 *      Las `personal` (activaciones, seguimientos, operaciones, rutinas) son
 *      de CADA persona, como en sus pantallas: se leen con el id de quien mira
 *      (`SourceReadContext.viewerId`) y cada quien ve lo suyo. Sin alguien que
 *      mire —el enlace público, Inicio sin sesión— no se leen, y una vista que
 *      las usa tampoco se comparte por enlace.
 *
 * Lo que un campo NO expone también es decisión: el responsable de un cliente,
 * los teléfonos, las notas y el detalle de un vencimiento se quedan fuera de
 * las fuentes compartibles; los correos de contacto de un prospecto no salen
 * por ninguna.
 */

export type SourceSensitivity = 'shareable' | 'internal' | 'personal';

/** Quién está mirando. Sólo las fuentes `personal` y las del Feed lo usan. */
export interface SourceReadContext {
  viewerId: string | null;
}

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
  read(
    db: SupabaseClient,
    cap: number,
    today: string,
    ctx: SourceReadContext,
  ): Promise<PlatformSourceRead>;
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

/**
 * UNA FILA POR CLIENTE, CON SU PLATA Y SU CONTACTO (0179). Las cifras salen de
 * `loadClientList` (clients/hub-read.ts), la misma lectura de la lista de
 * /clients y de la ficha: facturado 12 meses, saldo, vencido, días de pago,
 * último contacto, próximo vencimiento y salud. Es INTERNA desde que lleva el
 * responsable y cuánto debe cada cliente: no se comparte por enlace.
 */
const HEALTH_LABELS = [
  'Al día',
  'Pagos atrasados',
  'Cartera muy vencida',
  'Debe y está callado',
  'Sin movimiento',
  'Bloqueado',
];

const clientes: PlatformSource = {
  id: 'cortex.clientes',
  name: 'Clientes',
  description:
    'Una fila por cliente: NIT, estado, responsable, etiquetas y origen, con lo facturado en 12 meses, el saldo por cobrar, lo vencido, los días promedio de pago, el último contacto, el próximo vencimiento y su salud en palabras. Interna.',
  sensitivity: 'internal',
  fields: [
    field('razon_social', 'Razón social', 'text'),
    field('nit', 'NIT', 'text'),
    field('estado', 'Estado', 'select', Object.values(CLIENT_STATUS_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('etiquetas', 'Etiquetas', 'text'),
    field('origen', 'Origen', 'select', Object.values(CLIENT_SOURCE_LABEL)),
    field('ciudad', 'Ciudad', 'text'),
    field('departamento', 'Departamento', 'text'),
    field('servicios', 'Servicios', 'text'),
    field('plazo_pago', 'Plazo de pago (días)', 'number'),
    field('cupo', 'Cupo de crédito (COP)', 'money'),
    field('cliente_desde', 'Cliente desde', 'date'),
    field('facturado_12m', 'Facturado 12 meses (COP)', 'money'),
    field('saldo', 'Saldo por cobrar (COP)', 'money'),
    field('vencido', 'Vencido (COP)', 'money'),
    field('dias_pago', 'Días promedio de pago', 'number'),
    field('ultimo_contacto', 'Último contacto', 'date'),
    field('proximo_vencimiento', 'Próximo vencimiento', 'date'),
    field('salud', 'Salud', 'select', HEALTH_LABELS),
  ],
  async read(db, cap, today) {
    const [all, list] = await Promise.all([
      listClients(db, { limit: cap + 1 }),
      loadClientList(db, { today }),
    ]);
    const hub = new Map(list.rows.map((r) => [r.id, r]));
    const rows = all.slice(0, cap).map((c) => {
      const h = hub.get(c.id);
      const values: Values = {};
      put(values, 'razon_social', c.legal_name);
      put(values, 'nit', fullNit(c.tax_id));
      put(values, 'estado', CLIENT_STATUS_LABEL[c.status] ?? c.status);
      put(values, 'responsable', c.owner_name);
      put(values, 'etiquetas', (c.tags ?? []).join(', '));
      put(
        values,
        'origen',
        CLIENT_SOURCE_LABEL[(c.source ?? 'manual') as keyof typeof CLIENT_SOURCE_LABEL],
      );
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
      put(values, 'facturado_12m', h?.invoiced12m);
      put(values, 'saldo', h?.outstanding);
      put(values, 'vencido', h?.overdue);
      put(values, 'dias_pago', h?.paymentDays);
      put(values, 'ultimo_contacto', dayOf(h?.lastContactAt));
      put(values, 'proximo_vencimiento', h?.nextDueOn);
      put(values, 'salud', h?.health.label);
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
// Activaciones: lo que cada persona puso a vigilar sus fuentes del Feed
// ---------------------------------------------------------------------------

/**
 * ACTIVACIONES, SEGUIMIENTOS Y OPERACIONES SON DE CADA PERSONA.
 *
 * Toda lectura de `activation_runs`, `activation_automations` y
 * `activation_operations` en la app filtra por `actor_id` (ver
 * apps/web/app/api/activations/** y lib/management/activation-execution.ts):
 * nacen de fuentes privadas del Feed y ni un administrador ve las de otro.
 * Una vista no cambia esa regla: estas fuentes leen SÓLO las filas de quien
 * mira (`ctx.viewerId`). Un tablero de «mis activaciones» abierto por un
 * compañero muestra las de ese compañero, nunca las del autor de la vista.
 *
 * Lo que sí es de la empresa —los asuntos de Gerencia que una activación
 * publicó— ya está en `cortex.gestion`.
 */
const RUN_STATE: Record<string, string> = { simulated: 'Simulada', committed: 'Publicada' };
const RULE_KIND = ['Facturas duplicadas', 'Duplicados', 'Condiciones'];
const ORIGIN = ['Manual', 'Seguimiento'];

/**
 * Cada simulación carga hasta mil candidatos con sus valores, y contarlos
 * exige leerlos (PostgREST no cuenta dentro de un jsonb sin una función). La
 * pantalla de Activaciones lee 50; una vista que se refresca sola lee las 100
 * más recientes y se marca parcial si hay más.
 */
const RUNS_CAP = 100;

function ruleKind(definition: unknown): string | null {
  const d = (definition ?? {}) as { kind?: unknown; rule?: unknown };
  if (d.kind === 'invoice_duplicates') return 'Facturas duplicadas';
  if (d.kind === 'table_rule') return d.rule === 'duplicates' ? 'Duplicados' : 'Condiciones';
  return null;
}

const nameOf = (definition: unknown): string | null => {
  const name = (definition as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
};

const activaciones: PlatformSource = {
  id: 'cortex.activaciones',
  name: 'Mis activaciones (simulaciones y publicaciones)',
  description:
    'Cada vez que una regla revisó una fuente del Feed: cuándo, con qué regla, cuántas filas coincidieron, cuántas quedaron inválidas y cuántos asuntos publicó. Cada persona ve sólo las suyas.',
  sensitivity: 'personal',
  fields: [
    field('fecha', 'Fecha', 'date'),
    field('estado', 'Estado', 'select', Object.values(RUN_STATE)),
    field('regla', 'Tipo de regla', 'select', RULE_KIND),
    field('origen', 'Origen', 'select', ORIGIN),
    field('fuente', 'Fuente', 'text'),
    field('hoja', 'Hoja', 'text'),
    field('filas', 'Filas revisadas', 'number'),
    field('coincidencias', 'Coincidencias', 'number'),
    field('invalidas', 'Filas inválidas', 'number'),
    field('asuntos', 'Asuntos publicados', 'number'),
    field('publicada', 'Publicada el', 'date'),
  ],
  async read(db, cap, _today, ctx) {
    if (!ctx.viewerId) return { rows: [], truncated: false };
    const limit = Math.min(cap, RUNS_CAP);
    const { data, error } = await db
      .from('activation_runs')
      .select(
        'id, source_name, sheet_name, definition, candidates, status, case_ids, identity_namespace, created_at, committed_at',
      )
      .eq('actor_id', ctx.viewerId)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      source_name: string;
      sheet_name: string;
      definition: unknown;
      candidates: Array<{ status?: string }> | null;
      status: string;
      case_ids: string[] | null;
      identity_namespace: string | null;
      created_at: string;
      committed_at: string | null;
    }>;
    const rows = all.slice(0, limit).map((r) => {
      const values: Values = {};
      const candidates = Array.isArray(r.candidates) ? r.candidates : [];
      put(values, 'fecha', dayOf(r.created_at));
      put(values, 'estado', RUN_STATE[r.status] ?? r.status);
      put(values, 'regla', ruleKind(r.definition));
      put(
        values,
        'origen',
        r.identity_namespace?.startsWith('automation:') ? 'Seguimiento' : 'Manual',
      );
      put(values, 'fuente', r.source_name?.slice(0, 200));
      put(values, 'hoja', r.sheet_name?.slice(0, 200));
      put(values, 'filas', candidates.length);
      put(values, 'coincidencias', candidates.filter((c) => c?.status === 'matched').length);
      put(values, 'invalidas', candidates.filter((c) => c?.status === 'invalid').length);
      put(values, 'asuntos', r.case_ids?.length ?? 0);
      put(values, 'publicada', dayOf(r.committed_at));
      return row(
        r.id,
        nameOf(r.definition) ?? r.source_name ?? 'Activación',
        values,
        r.created_at,
        r.committed_at ?? r.created_at,
      );
    });
    return { rows, truncated: all.length > limit };
  },
};

const AUTOMATION_STATE: Record<string, string> = {
  active: 'Activa',
  paused: 'En pausa',
  needs_review: 'Necesita revisión',
};
const TRIGGER_LABEL: Record<string, string> = {
  on_change: 'Al cambiar la fuente',
  scheduled: 'Por frecuencia',
};
const INTERVAL_LABEL: Record<number, string> = {
  60: 'Cada hora',
  360: 'Cada 6 horas',
  1440: 'Cada día',
  10080: 'Cada semana',
};
const OUTCOME_LABEL: Record<string, string> = {
  unchanged: 'Sin cambios',
  checked: 'Revisada',
  needs_review: 'Necesita revisión',
  error: 'Error',
};

const seguimientos: PlatformSource = {
  id: 'cortex.seguimientos',
  name: 'Mis seguimientos automáticos',
  description:
    'Las reglas autorizadas para revisar solas una fuente conectada: si están activas, en pausa o necesitan revisión, cada cuánto corren, cuándo revisaron y qué encontraron. Cada persona ve sólo los suyos.',
  sensitivity: 'personal',
  fields: [
    field('estado', 'Estado', 'select', Object.values(AUTOMATION_STATE)),
    field('disparador', 'Cuándo corre', 'select', Object.values(TRIGGER_LABEL)),
    field('frecuencia', 'Frecuencia', 'select', Object.values(INTERVAL_LABEL)),
    field('fuente', 'Fuente conectada', 'text'),
    field('ultima_revision', 'Última revisión', 'date'),
    field('proxima_revision', 'Próxima revisión', 'date'),
    field('resultado', 'Último resultado', 'select', Object.values(OUTCOME_LABEL)),
    field('coincidencias', 'Coincidencias en la última', 'number'),
    field('asuntos_nuevos', 'Asuntos nuevos en la última', 'number'),
    field('mensaje', 'Mensaje', 'text'),
  ],
  async read(db, cap, _today, ctx) {
    if (!ctx.viewerId) return { rows: [], truncated: false };
    const { data, error } = await db
      .from('activation_automations')
      .select(
        'id, name, source_connection_id, trigger, interval_minutes, status, next_run_at, last_checked_at, last_result, created_at, updated_at',
      )
      .eq('actor_id', ctx.viewerId)
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      name: string;
      source_connection_id: string;
      trigger: string;
      interval_minutes: number;
      status: string;
      next_run_at: string | null;
      last_checked_at: string | null;
      last_result: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    }>;
    const list = all.slice(0, cap);
    const viewer = ctx.viewerId;
    const conns = await inChunks(unique(list.map((a) => a.source_connection_id)), async (chunk) => {
      const read = await db
        .from('feed_sources')
        .select('id, name')
        .eq('actor_id', viewer)
        .in('id', chunk);
      if (read.error) throw read.error;
      return (read.data ?? []) as Array<{ id: string; name: string }>;
    });
    const connName = new Map(conns.map((c) => [c.id, c.name]));
    const rows = list.map((a) => {
      const values: Values = {};
      const last = a.last_result ?? {};
      const num0 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      put(values, 'estado', AUTOMATION_STATE[a.status] ?? a.status);
      put(values, 'disparador', TRIGGER_LABEL[a.trigger] ?? a.trigger);
      put(values, 'frecuencia', INTERVAL_LABEL[a.interval_minutes] ?? null);
      put(values, 'fuente', connName.get(a.source_connection_id)?.slice(0, 200));
      put(values, 'ultima_revision', dayOf(a.last_checked_at));
      if (a.status === 'active') put(values, 'proxima_revision', dayOf(a.next_run_at));
      put(
        values,
        'resultado',
        typeof last.outcome === 'string' ? (OUTCOME_LABEL[last.outcome] ?? null) : null,
      );
      put(values, 'coincidencias', num0(last.matched));
      put(values, 'asuntos_nuevos', num0(last.created));
      put(values, 'mensaje', typeof last.message === 'string' ? last.message.slice(0, 300) : null);
      return row(a.id, a.name?.slice(0, 120) || 'Seguimiento', values, a.created_at, a.updated_at);
    });
    return { rows, truncated: all.length > cap };
  },
};

/** Los mismos nombres que la pantalla de Activaciones (ActivationExecution.tsx). */
const OPERATION_STATE: Record<string, string> = {
  awaiting_approval: 'Pendiente de aprobación',
  executing: 'Ejecutando',
  verifying: 'Verificando',
  succeeded: 'Verificado',
  blocked: 'Bloqueado',
  failed: 'Falló',
  cancelled: 'Cancelado',
  outcome_unknown: 'Resultado desconocido',
  verification_failed: 'No coincidió la verificación',
};

/**
 * La comprobación, en una palabra. «Verificado» sólo cuando el verificador GET
 * coincidió: una respuesta HTTP exitosa no basta (docs/features/activations.md).
 */
function verificationOf(status: string): string {
  if (status === 'succeeded') return 'Comprobada';
  if (status === 'verification_failed') return 'No coincidió';
  if (status === 'outcome_unknown') return 'Incierta';
  if (status === 'awaiting_approval' || status === 'executing' || status === 'verifying')
    return 'En curso';
  return 'Sin comprobar';
}
const VERIFICATION = ['Comprobada', 'No coincidió', 'Incierta', 'En curso', 'Sin comprobar'];

const operaciones: PlatformSource = {
  id: 'cortex.operaciones',
  name: 'Mis operaciones (acciones comprobadas)',
  description:
    'Las acciones externas que salieron de una activación: qué herramienta, sobre qué asunto, en qué estado, si la verificación posterior coincidió, cuántos intentos y cuánto tardó. Cada persona ve sólo las suyas.',
  sensitivity: 'personal',
  fields: [
    field('estado', 'Estado', 'select', Object.values(OPERATION_STATE)),
    field('verificacion', 'Verificación', 'select', VERIFICATION),
    field('accion', 'Herramienta', 'text'),
    field('verificador', 'Verificador', 'text'),
    field('asunto', 'Asunto', 'text'),
    field('intentos', 'Intentos', 'number'),
    field('creada', 'Preparada el', 'date'),
    field('terminada', 'Terminada el', 'date'),
    field('duracion_s', 'Duración (segundos)', 'number'),
    field('error', 'Error', 'text'),
  ],
  async read(db, cap, _today, ctx) {
    if (!ctx.viewerId) return { rows: [], truncated: false };
    // Columnas nombradas: ni la entrada de la herramienta, ni su respuesta, ni
    // la evidencia copiada del Feed viajan a una vista.
    const { data, error } = await db
      .from('activation_operations')
      .select(
        'id, case_id, action_tool_id, verifier_tool_id, status, attempt, error, started_at, completed_at, created_at, updated_at',
      )
      .eq('actor_id', ctx.viewerId)
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    if (error) throw error;
    const all = (data ?? []) as Array<{
      id: string;
      case_id: string;
      action_tool_id: string;
      verifier_tool_id: string;
      status: string;
      attempt: number;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const list = all.slice(0, cap);
    const cases = await inChunks(unique(list.map((o) => o.case_id)), async (chunk) => {
      const read = await db.from('management_cases').select('id, data').in('id', chunk);
      if (read.error) throw read.error;
      return (read.data ?? []) as Array<{ id: string; data: { title?: unknown } | null }>;
    });
    const caseTitle = new Map(
      cases.map((c) => [c.id, typeof c.data?.title === 'string' ? c.data.title : null]),
    );
    const tool = (id: string) => id.replace(/^custom\./, '');
    const rows = list.map((o) => {
      const values: Values = {};
      const title = caseTitle.get(o.case_id) ?? null;
      put(values, 'estado', OPERATION_STATE[o.status] ?? o.status);
      put(values, 'verificacion', verificationOf(o.status));
      put(values, 'accion', tool(o.action_tool_id));
      put(values, 'verificador', tool(o.verifier_tool_id));
      put(values, 'asunto', title?.slice(0, 200));
      put(values, 'intentos', o.attempt);
      put(values, 'creada', dayOf(o.created_at));
      put(values, 'terminada', dayOf(o.completed_at));
      if (o.started_at && o.completed_at) {
        const ms = Date.parse(o.completed_at) - Date.parse(o.started_at);
        if (Number.isFinite(ms) && ms >= 0) put(values, 'duracion_s', Math.round(ms / 1000));
      }
      put(values, 'error', o.error?.slice(0, 300));
      return row(o.id, title ?? tool(o.action_tool_id), values, o.created_at, o.updated_at);
    });
    return { rows, truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Rutinas: las corridas de lo programado
// ---------------------------------------------------------------------------

const JOB_RUN_STATE: Record<string, string> = {
  running: 'En curso',
  ok: 'Correcta',
  error: 'Con error',
};
const JOB_STATE: Record<string, string> = {
  active: 'Activa',
  paused: 'En pausa',
  completed: 'Completada',
  cancelled: 'Cancelada',
};
const JOB_KIND: Record<string, string> = { tool: 'Herramienta', agent: 'Agente' };
const JOB_SCOPE = ['Mía', 'De todo el equipo'];

/**
 * Las mismas rutinas que /schedules le muestra a cada quien: las suyas y las
 * globales del equipo (`user_id = yo OR is_global`). Ni la salida ni la
 * instrucción viajan: sólo si corrió, cuándo, cuánto tardó y el error.
 */
const rutinas: PlatformSource = {
  id: 'cortex.rutinas',
  name: 'Corridas de mis rutinas',
  description:
    'Cada vez que corrió una rutina programada (las tuyas y las globales del equipo): si salió bien o con error, cuándo, cuánto tardó y el error. Cada persona ve las que su pantalla de Rutinas le muestra.',
  sensitivity: 'personal',
  fields: [
    field('estado', 'Resultado', 'select', Object.values(JOB_RUN_STATE)),
    field('inicio', 'Corrió el', 'date'),
    field('duracion_s', 'Duración (segundos)', 'number'),
    field('tipo', 'Tipo', 'select', Object.values(JOB_KIND)),
    field('alcance', 'De quién', 'select', JOB_SCOPE),
    field('rutina_estado', 'Estado de la rutina', 'select', Object.values(JOB_STATE)),
    field('error', 'Error', 'text'),
  ],
  async read(db, cap, _today, ctx) {
    if (!ctx.viewerId) return { rows: [], truncated: false };
    // Dos lecturas en vez de un `.or()` armado con texto: el id de quien mira
    // nunca se interpola en un filtro.
    const JOB_COLUMNS = 'id, name, kind, status, is_global, user_id';
    const [own, global] = await Promise.all([
      db.from('scheduled_jobs').select(JOB_COLUMNS).eq('user_id', ctx.viewerId).limit(300),
      db.from('scheduled_jobs').select(JOB_COLUMNS).eq('is_global', true).limit(300),
    ]);
    if (own.error) throw own.error;
    if (global.error) throw global.error;
    type Job = {
      id: string;
      name: string;
      kind: string;
      status: string;
      is_global: boolean | null;
      user_id: string;
    };
    const byId = new Map(
      [...((own.data ?? []) as Job[]), ...((global.data ?? []) as Job[])].map((j) => [j.id, j]),
    );
    const jobs = [...byId.values()];
    if (!jobs.length) return { rows: [], truncated: false };
    const runs = await inChunks(
      jobs.map((j) => j.id),
      async (chunk) => {
        const read = await db
          .from('scheduled_job_runs')
          .select('id, job_id, status, started_at, finished_at, error')
          .in('job_id', chunk)
          .order('started_at', { ascending: false })
          .limit(cap + 1);
        if (read.error) throw read.error;
        return (read.data ?? []) as Array<{
          id: string;
          job_id: string;
          status: string;
          started_at: string;
          finished_at: string | null;
          error: string | null;
        }>;
      },
    );
    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    const rows = runs.slice(0, cap).map((r) => {
      const job = byId.get(r.job_id);
      const values: Values = {};
      put(values, 'estado', JOB_RUN_STATE[r.status] ?? r.status);
      put(values, 'inicio', dayOf(r.started_at));
      if (r.finished_at) {
        const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
        if (Number.isFinite(ms) && ms >= 0) put(values, 'duracion_s', Math.round(ms / 1000));
      }
      put(values, 'tipo', job ? (JOB_KIND[job.kind] ?? job.kind) : null);
      put(
        values,
        'alcance',
        job ? (job.user_id === ctx.viewerId ? 'Mía' : 'De todo el equipo') : null,
      );
      put(values, 'rutina_estado', job ? (JOB_STATE[job.status] ?? job.status) : null);
      put(values, 'error', r.error?.slice(0, 300));
      return row(
        r.id,
        job?.name?.slice(0, 120) ?? 'Rutina',
        values,
        r.started_at,
        r.finished_at ?? r.started_at,
      );
    });
    return { rows, truncated: runs.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Cartera vencida: la plata en riesgo, con las facturas de programa contable
// ---------------------------------------------------------------------------

const TRAMOS = ['1 a 30 días', '31 a 60 días', '61 a 90 días', 'Más de 90 días'];
const CARTERA_ORIGEN = ['Documento confirmado', 'Siigo', 'Alegra', 'QuickBooks', 'Otro programa'];
const SYSTEM_NAME: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

function tramoOf(days: number): string {
  if (days <= 30) return TRAMOS[0] as string;
  if (days <= 60) return TRAMOS[1] as string;
  if (days <= 90) return TRAMOS[2] as string;
  return TRAMOS[3] as string;
}

/**
 * LA CARTERA VENCIDA COMO LA SUMA «PLATA EN RIESGO».
 *
 * `cortex.ventas` sólo ve facturas leídas de documentos y confirmadas. Una
 * empresa que conectó Siigo, Alegra o QuickBooks (0165) tiene su cartera en
 * `accounting_invoices`, y la cifra de plata en riesgo ya las suma juntas con
 * una regla (`overdueReceivableInvoices`): el saldo del programa contable va
 * tal cual, y una factura que existe en los dos lados cuenta una vez. Esta
 * fuente es esa misma lista, fila por fila, para que el tablero y la cifra de
 * la mañana digan lo mismo.
 */
const cartera: PlatformSource = {
  id: 'cortex.cartera',
  name: 'Cartera vencida',
  description:
    'Facturas por cobrar que ya pasaron su fecha y tienen saldo: las confirmadas a mano y las de Siigo, Alegra o QuickBooks, contadas una sola vez. Es la cartera de «plata en riesgo».',
  sensitivity: 'shareable',
  fields: [
    field('numero', 'Número', 'text'),
    field('cliente', 'Cliente', 'text'),
    field('vence', 'Venció el', 'date'),
    field('dias_mora', 'Días de mora', 'number'),
    field('tramo', 'Tramo de mora', 'select', TRAMOS),
    field('saldo', 'Saldo (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('saldo_otra_moneda', 'Saldo en otra moneda', 'number'),
    field('origen', 'De dónde viene', 'select', CARTERA_ORIGEN),
  ],
  async read(db, cap, today) {
    const list = await overdueReceivableInvoices(db, { today });
    const rows = list.slice(0, cap).map((inv) => {
      const values: Values = {};
      put(values, 'numero', inv.docNumber);
      put(values, 'cliente', inv.counterparty);
      put(values, 'vence', inv.dueOn);
      put(values, 'dias_mora', inv.daysOverdue);
      put(values, 'tramo', tramoOf(inv.daysOverdue));
      put(values, 'moneda', inv.currency);
      if (inv.currency.trim().toUpperCase() === COP) put(values, 'saldo', inv.balance);
      else put(values, 'saldo_otra_moneda', inv.balance);
      put(
        values,
        'origen',
        inv.source === 'accounting'
          ? (SYSTEM_NAME[inv.system ?? ''] ?? 'Otro programa')
          : 'Documento confirmado',
      );
      return row(
        `${inv.source ?? 'document'}:${inv.id}`,
        inv.docNumber ?? inv.counterparty ?? 'Factura',
        values,
        null,
      );
    });
    return { rows, truncated: list.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Plata recuperada con Cortex
// ---------------------------------------------------------------------------

const MANUAL_RECOVERY = 'Cierre verificado en Gerencia';
const RECOVERY_KIND: Record<string, string> = {
  payment: 'Pago',
  reversal: 'Devolución',
  balance_drop: 'Baja de saldo',
};

/**
 * LO QUE VOLVIÓ PORQUE CORTEX ACTUÓ (payments/recovered.ts tiene las reglas).
 *
 * Una fila por movimiento atribuido —un pago, una devolución que resta, una
 * caída de saldo del programa contable— y una por lo manual verificado en
 * Gerencia, con el día en que pasó. Así un KPI «este mes contra el anterior»
 * suma lo mismo que la cifra de /payments. Es `internal`: lo manual lleva el
 * título de un asunto de Gerencia, y cómo cobra la empresa no es para afuera.
 */
const recuperado: PlatformSource = {
  id: 'cortex.recuperado',
  name: 'Plata recuperada con Cortex',
  description:
    'Pagos de facturas vencidas que llegaron después de que Cortex cobró, avisó o hizo seguimiento (dentro de la ventana de atribución), más lo recuperado a mano y verificado en Gerencia. Una fila por movimiento, con su fecha.',
  sensitivity: 'internal',
  fields: [
    field('fecha', 'Fecha', 'date'),
    field('cliente', 'Cliente', 'text'),
    field('factura', 'Factura', 'text'),
    field('valor', 'Recuperado (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('valor_otra_moneda', 'Recuperado en otra moneda', 'number'),
    field('accion', 'Qué hizo Cortex', 'select', [
      ...Object.values(RECOVERY_TRIGGER_LABEL),
      MANUAL_RECOVERY,
    ]),
    field('tipo', 'Movimiento', 'select', [...Object.values(RECOVERY_KIND), 'Manual']),
  ],
  async read(db, cap, today) {
    const recovered = await moneyRecovered(db, { today });
    const all: ViewRow[] = [];
    for (const inv of recovered.items) {
      for (const m of inv.movements) {
        const values: Values = {};
        put(values, 'fecha', m.on);
        put(values, 'cliente', inv.counterparty);
        put(values, 'factura', inv.docNumber);
        put(values, 'moneda', inv.currency);
        if (inv.currency.trim().toUpperCase() === COP) put(values, 'valor', m.counted);
        else put(values, 'valor_otra_moneda', m.counted);
        put(values, 'accion', m.trigger.label);
        put(values, 'tipo', RECOVERY_KIND[m.kind] ?? null);
        all.push(
          row(
            `${inv.invoiceId}:${m.id}`,
            inv.docNumber ?? inv.counterparty ?? 'Factura',
            values,
            null,
          ),
        );
      }
    }
    for (const m of recovered.manual) {
      const values: Values = {};
      put(values, 'fecha', m.on);
      put(values, 'valor', m.counted);
      put(values, 'moneda', COP);
      put(values, 'accion', MANUAL_RECOVERY);
      put(values, 'tipo', 'Manual');
      all.push(
        row(`manual:${m.caseId}`, m.title.slice(0, 120) || 'Asunto de Gerencia', values, null),
      );
    }
    all.sort((a, b) => String(b.values.fecha ?? '').localeCompare(String(a.values.fecha ?? '')));
    return { rows: all.slice(0, cap), truncated: all.length > cap };
  },
};

// ---------------------------------------------------------------------------
// El libro de plata y la caja (migración 0172)
// ---------------------------------------------------------------------------

const LIBRO_SENTIDO = ['Entra', 'Sale'];
const LIBRO_ESTADO = ['Esperado', 'Pasó'];
const SIN_CATEGORIA = 'Sin categoría';

/**
 * EL LIBRO DE PLATA, FILA POR FILA: lo que entró y salió y lo que está por
 * cobrar y por pagar, con su categoría y su mes, contado una sola vez (sin
 * duplicados entre fuentes, sin anulados, sin pagos en disputa). Con esto un
 * tablero arma «gastos por categoría», «ventas contra gastos por mes» o «lo que
 * vence esta semana» sin una segunda verdad. Es `internal`: trae la nómina, el
 * arriendo y a quién le paga la empresa.
 *
 * LA NÓMINA ES CONFIDENCIAL (ledger/privacy.ts): quien no administra la
 * empresa —o una lectura sin nadie mirando— no ve sus filas: ve un total por
 * mes, sentido y estado, rotulado «Nómina (confidencial)», sin contraparte.
 * Las sumas por categoría y por mes dan lo mismo; las personas no salen.
 */
const libro: PlatformSource = {
  id: 'cortex.libro',
  name: 'Libro de plata',
  description:
    'Todos los movimientos de plata de la empresa (programa contable, extractos del banco, pagos, facturas confirmadas y lo anotado a mano), contados una sola vez: fecha, mes, si entra o sale, clase (ingreso, gasto, por cobrar, por pagar), categoría, contraparte, valor y de dónde salió.',
  sensitivity: 'internal',
  fields: [
    field('fecha', 'Fecha', 'date'),
    field('mes', 'Mes', 'text'),
    field('sentido', 'Entra o sale', 'select', LIBRO_SENTIDO),
    field('clase', 'Clase', 'select', Object.values(LEDGER_KIND_LABEL)),
    field('estado', 'Estado', 'select', LIBRO_ESTADO),
    field('categoria', 'Categoría', 'select', [
      ...Object.values(LEDGER_CATEGORY_LABEL),
      SIN_CATEGORIA,
    ]),
    field('contraparte', 'Contraparte', 'text'),
    field('descripcion', 'Descripción', 'text'),
    field('valor', 'Valor (COP)', 'money'),
    field('pendiente', 'Pendiente (COP)', 'money'),
    field('vence', 'Vence', 'date'),
    field('moneda', 'Moneda', 'text'),
    field('valor_otra_moneda', 'Valor en otra moneda', 'number'),
    field('cuenta', 'Cuenta', 'text'),
    field('fuente', 'De dónde viene', 'select', Object.values(LEDGER_SOURCE_LABEL)),
  ],
  async read(db, cap, _today, ctx) {
    const [{ rows: all, truncated }, accounts, admin] = await Promise.all([
      listLedgerMovements(db, { limit: cap }),
      listLedgerAccounts(db),
      canSeePayrollDetail(db, ctx.viewerId),
    ]);
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const movements = admin ? all : all.filter((m) => !isPayrollCategory(m.category));
    const payroll = new Map<string, Values & { valor?: number; valor_otra_moneda?: number }>();
    if (!admin) {
      for (const m of all) {
        if (!isPayrollCategory(m.category)) continue;
        const key = `${m.date.slice(0, 7)}|${m.direction}|${m.kind}|${m.status}|${m.currency}`;
        const amount = ledgerNum(m.amount) ?? 0;
        const cop = m.currency.trim().toUpperCase() === COP;
        const entry = payroll.get(key) ?? {
          fecha: `${m.date.slice(0, 7)}-01`,
          mes: m.date.slice(0, 7),
          sentido: m.direction === 'in' ? 'Entra' : 'Sale',
          clase: LEDGER_KIND_LABEL[m.kind],
          estado: m.status === 'expected' ? 'Esperado' : 'Pasó',
          categoria: PAYROLL_CONFIDENTIAL_LABEL,
          descripcion: PAYROLL_CONFIDENTIAL_LABEL,
          moneda: m.currency,
        };
        if (cop) entry.valor = (entry.valor ?? 0) + amount;
        else entry.valor_otra_moneda = (entry.valor_otra_moneda ?? 0) + amount;
        payroll.set(key, entry);
      }
    }
    const rows = movements.map((m) => {
      const values: Values = {};
      const amount = ledgerNum(m.amount) ?? 0;
      const cop = m.currency.trim().toUpperCase() === COP;
      put(values, 'fecha', m.date);
      put(values, 'mes', m.date.slice(0, 7));
      put(values, 'sentido', m.direction === 'in' ? 'Entra' : 'Sale');
      put(values, 'clase', LEDGER_KIND_LABEL[m.kind]);
      put(values, 'estado', m.status === 'expected' ? 'Esperado' : 'Pasó');
      put(values, 'categoria', m.category ? ledgerCategoryLabel(m.category) : SIN_CATEGORIA);
      put(values, 'contraparte', m.counterparty_name);
      put(values, 'descripcion', m.description);
      put(values, 'moneda', m.currency);
      if (cop) put(values, 'valor', amount);
      else put(values, 'valor_otra_moneda', amount);
      if (cop && (m.kind === 'receivable' || m.kind === 'payable'))
        put(values, 'pendiente', ledgerNum(m.outstanding));
      put(values, 'vence', m.due_date);
      put(values, 'cuenta', m.account_id ? (accountName.get(m.account_id) ?? null) : null);
      put(values, 'fuente', LEDGER_SOURCE_LABEL[m.source_kind]);
      return row(
        m.id,
        m.description.slice(0, 120) || 'Movimiento',
        values,
        m.created_at,
        m.updated_at,
      );
    });
    for (const [key, values] of payroll) {
      rows.push(
        row(`nomina:${key}`, PAYROLL_CONFIDENTIAL_LABEL, values, `${values.fecha}T00:00:00Z`),
      );
    }
    return { rows, truncated };
  },
};

const CAJA_ORIGEN: Record<string, string> = {
  bank: 'Extracto del banco',
  manual: 'Dicho a mano',
  accounting: 'Programa contable',
};

/**
 * LA CAJA POR CUENTA: el último saldo conocido de cada cuenta propia y de qué
 * día es. `internal`: cuánta plata tiene la empresa no es para afuera.
 */
const caja: PlatformSource = {
  id: 'cortex.caja',
  name: 'Caja por cuenta',
  description:
    'Las cuentas propias (banco, efectivo) con su último saldo conocido, de qué día es y quién lo dijo (el extracto importado o una persona).',
  sensitivity: 'internal',
  fields: [
    field('cuenta', 'Cuenta', 'text'),
    field('saldo', 'Saldo (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('saldo_otra_moneda', 'Saldo en otra moneda', 'number'),
    field('al', 'Saldo al', 'date'),
    field('dias', 'Días desde el saldo', 'number'),
    field('origen', 'Quién dijo el saldo', 'select', Object.values(CAJA_ORIGEN)),
  ],
  async read(db, cap, today) {
    const accounts = await listLedgerAccounts(db);
    const rows = accounts.slice(0, cap).map((a) => {
      const values: Values = {};
      const balance = ledgerNum(a.balance) ?? 0;
      put(values, 'cuenta', a.name);
      put(values, 'moneda', a.currency);
      if (a.currency.trim().toUpperCase() === COP) put(values, 'saldo', balance);
      else put(values, 'saldo_otra_moneda', balance);
      put(values, 'al', a.balance_at);
      put(values, 'dias', Math.max(0, daysBetween(a.balance_at, today)));
      put(values, 'origen', CAJA_ORIGEN[a.balance_source] ?? null);
      return row(a.id, a.name, values, a.created_at, a.updated_at);
    });
    return { rows, truncated: accounts.length > cap };
  },
};

// ---------------------------------------------------------------------------
// La proyección de caja y las pérdidas y ganancias (0172 + 0173)
// ---------------------------------------------------------------------------

const FLUJO_SERIE = ['Base', 'Escenario'];

/**
 * LA CAJA DE LAS PRÓXIMAS 13 SEMANAS: una fila por semana con cuánto abre,
 * cuánto entra, cuánto sale y con cuánto cierra (ledger/plans.ts ›
 * runForecast, la misma proyección que contesta el chat). Sólo pesos. Si hay
 * escenarios guardados, el más reciente sale también, marcado «Escenario»,
 * para pintar la base contra el escenario. Sin cuentas ni nada esperado en el
 * libro, no hay filas: una caja «$ 0» sería «no hay datos» disfrazado.
 * `internal`: la caja de la empresa no es para afuera.
 */
const flujoCaja: PlatformSource = {
  id: 'cortex.flujo_caja',
  name: 'Proyección de caja',
  description:
    'La caja de las próximas 13 semanas, semana por semana: con cuánto abre, cuánto se espera que entre y que salga, y con cuánto cierra; con la semana más apretada marcada. Si hay un escenario guardado, también sus semanas.',
  sensitivity: 'internal',
  fields: [
    field('semana', 'Semana (lunes)', 'date'),
    field('abre', 'Abre (COP)', 'money'),
    field('entra', 'Entra (COP)', 'money'),
    field('sale', 'Sale (COP)', 'money'),
    field('cierra', 'Cierra (COP)', 'money'),
    field('escenario', 'Serie', 'select', FLUJO_SERIE),
    field('nombre_escenario', 'Escenario', 'text'),
    field('mas_apretada', 'Semana más apretada', 'select', ['Sí', 'No']),
    field('semanas_de_caja', 'Semanas de caja', 'number'),
  ],
  async read(db, cap, today) {
    const { data: latest, error } = await db
      .from('ledger_scenarios')
      .select('id')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const scenarioId = (latest as { id: string } | null)?.id ?? null;
    const result = await runForecast(db, { today, currency: COP, scenarioId });
    const base = result.base;
    const empty = (base.accountCount ?? 0) === 0 && base.weeks.every((w) => w.items.length === 0);
    if (empty) return { rows: [], truncated: false };
    const rows: ViewRow[] = [];
    const series = [
      { r: base, serie: 'Base', name: null as string | null },
      ...(result.scenario
        ? [
            {
              r: result.scenario,
              serie: 'Escenario',
              name: result.scenario.scenario?.label ?? null,
            },
          ]
        : []),
    ];
    const created = `${today}T00:00:00Z`;
    for (const { r, serie, name } of series) {
      const runway = cashRunwayWeeks(r);
      for (const w of r.weeks) {
        const values: Values = {};
        put(values, 'semana', w.start);
        put(values, 'abre', w.opening);
        put(values, 'entra', w.inflows);
        put(values, 'sale', w.outflows);
        put(values, 'cierra', w.closing);
        put(values, 'escenario', serie);
        put(values, 'nombre_escenario', name);
        put(values, 'mas_apretada', w.start === r.lowest.week ? 'Sí' : 'No');
        put(values, 'semanas_de_caja', runway ?? r.weeks.length);
        rows.push(row(`${serie}:${w.start}`, `Semana del ${w.start}`, values, created));
      }
    }
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  },
};

/**
 * PÉRDIDAS Y GANANCIAS POR MES (de caja): ventas, otros ingresos, gastos y
 * margen de los últimos 12 meses, y una fila por categoría de gasto
 * (`tipo = Gasto por categoría`) para pintar en qué se va la plata. Sólo
 * pesos. La nómina, sin permiso de verla, como un solo total confidencial.
 * `internal`.
 */
const pyg: PlatformSource = {
  id: 'cortex.pyg',
  name: 'Pérdidas y ganancias por mes',
  description:
    'Por mes (últimos 12, de caja): ventas, otros ingresos, gastos y margen; y una fila por cada categoría de gasto del mes (tipo «Gasto por categoría») para ver en qué se va la plata.',
  sensitivity: 'internal',
  fields: [
    field('mes', 'Mes', 'text'),
    field('fecha', 'Primer día del mes', 'date'),
    field('tipo', 'Tipo', 'select', ['Resumen', 'Gasto por categoría']),
    field('ventas', 'Ventas (COP)', 'money'),
    field('otros_ingresos', 'Otros ingresos (COP)', 'money'),
    field('gastos', 'Gastos (COP)', 'money'),
    field('margen', 'Margen (COP)', 'money'),
    field('categoria', 'Categoría', 'select', [
      ...Object.values(LEDGER_CATEGORY_LABEL),
      PAYROLL_CONFIDENTIAL_LABEL,
      SIN_CATEGORIA,
    ]),
    field('valor', 'Valor (COP)', 'money'),
  ],
  async read(db, cap, today, ctx) {
    const admin = await canSeePayrollDetail(db, ctx.viewerId);
    const months = await monthlyPnl(db, {
      months: 12,
      currency: COP,
      today,
      includePayroll: admin,
    });
    if (months.every((m) => m.sales === 0 && m.otherIncome === 0 && m.expenses === 0))
      return { rows: [], truncated: false };
    const rows: ViewRow[] = [];
    for (const m of months) {
      const fecha = `${m.month}-01`;
      const created = `${fecha}T00:00:00Z`;
      const summary: Values = {};
      put(summary, 'mes', m.month);
      put(summary, 'fecha', fecha);
      put(summary, 'tipo', 'Resumen');
      put(summary, 'ventas', m.sales);
      put(summary, 'otros_ingresos', m.otherIncome);
      put(summary, 'gastos', m.expenses);
      put(summary, 'margen', m.margin);
      rows.push(row(`pyg:${m.month}`, `Mes ${m.month}`, summary, created));
      for (const [key, value] of Object.entries(m.byCategory)) {
        const values: Values = {};
        const label =
          key === PAYROLL_CONFIDENTIAL_KEY
            ? PAYROLL_CONFIDENTIAL_LABEL
            : key === 'sin_categoria'
              ? SIN_CATEGORIA
              : ledgerCategoryLabel(key);
        put(values, 'mes', m.month);
        put(values, 'fecha', fecha);
        put(values, 'tipo', 'Gasto por categoría');
        put(values, 'categoria', label);
        put(values, 'valor', value);
        rows.push(row(`pyg:${m.month}:${key}`, `${label} · ${m.month}`, values, created));
      }
    }
    return { rows: rows.slice(0, cap), truncated: rows.length > cap };
  },
};

// ---------------------------------------------------------------------------
// El registro
// ---------------------------------------------------------------------------

export const PLATFORM_SOURCES: ReadonlyMap<string, PlatformSource> = new Map(
  [
    ventas,
    pagos,
    cartera,
    recuperado,
    libro,
    caja,
    flujoCaja,
    pyg,
    clientes,
    vencimientos,
    compromisos,
    metas,
    gestion,
    prospectos,
    activaciones,
    seguimientos,
    operaciones,
    rutinas,
    // El registro de trabajo (0174): work/view-sources.ts, con su propia regla
    // de quién ve el trabajo de quién.
    trabajoSource,
    equipoSource,
  ].map((s) => [s.id, s]),
);

export function platformSource(id: string): PlatformSource | null {
  return PLATFORM_SOURCES.get(id) ?? null;
}

/** Lo mínimo para decir por qué una vista no sale del equipo. */
export interface UnshareableSource {
  id: string;
  name: string;
}

/** Cómo se nombra, en el aviso de compartir, una tabla del Feed (sin leerla). */
export const FEED_SOURCE_SHARE_NAME = 'tablas del Feed privado';

/**
 * Las fuentes de un spec que impiden abrir la puerta de afuera: las internas,
 * las personales y cualquier tabla del Feed. Vacío = se puede compartir. Las
 * del Feed no se leen para nombrarlas (el nombre de un archivo del Feed
 * también es privado): salen todas como una sola entrada genérica.
 */
export function internalSourcesOf(spec: ViewSpec): UnshareableSource[] {
  const refs = trackersOf(spec);
  const out: UnshareableSource[] = refs
    .map((ref) => PLATFORM_SOURCES.get(ref))
    .filter((s): s is PlatformSource => Boolean(s) && s?.sensitivity !== 'shareable')
    .map((s) => ({ id: s.id, name: s.name }));
  const feed = refs.filter(isFeedSourceId);
  if (feed.length) out.push({ id: feed[0] as string, name: FEED_SOURCE_SHARE_NAME });
  return out;
}

/** Lo que se le dice a quien intenta abrir la puerta de una vista con fuentes internas. */
export function internalShareRefusal(sources: UnshareableSource[]): string {
  const names = sources.map((s) => `«${s.name}»`).join(', ');
  return `Esta vista usa información interna del equipo o de cada persona (${names}) y no se puede compartir por enlace ni con contraseña. Quita esos bloques, o haz otra vista sólo con datos que se puedan mostrar afuera.`;
}

/** Lee una fuente de la plataforma. `today` en Bogotá por defecto. */
export async function readPlatformSource(
  db: SupabaseClient,
  id: string,
  cap: number,
  today: string = bogotaToday(),
  ctx: SourceReadContext = { viewerId: null },
): Promise<PlatformSourceRead | null> {
  const source = PLATFORM_SOURCES.get(id);
  if (!source) return null;
  return source.read(db, Math.max(1, cap), today, ctx);
}

/**
 * Las fuentes en texto, para la descripción de las herramientas: id, nombre,
 * campos y si son internas. Se genera del registro para que el modelo nunca
 * lea una lista de campos distinta de la que `checkSpecAgainst` comprueba.
 */
export function platformSourcesGrammar(): string {
  const note: Record<SourceSensitivity, string> = {
    shareable: '',
    internal: '; INTERNAL: a view using it cannot be shared by link',
    personal:
      '; PERSONAL: each viewer sees only their own rows; a view using it cannot be shared by link',
  };
  return [...PLATFORM_SOURCES.values()]
    .map(
      (s) =>
        `- ${s.id} (${s.name}${note[s.sensitivity]}): ${s.fields
          .map((f) => `${f.key}:${f.type}${f.options ? `[${f.options.join('|')}]` : ''}`)
          .join(', ')}`,
    )
    .join('\n');
}
