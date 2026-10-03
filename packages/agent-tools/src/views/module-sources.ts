import type { SupabaseClient } from '@supabase/supabase-js';
import { daysBetween } from '../commitments/shape';
import { businessDaysLeft } from '../compliance/pqrs';
import {
  COMPLIANCE_AREA_LABEL,
  type ItemRow as ComplianceItemRow,
  ITEM_FREQUENCY_LABEL,
  ITEM_STATUS_LABEL,
  PQRS_CHANNEL_LABEL,
  PQRS_KIND_LABEL,
  PQRS_MATTER_LABEL,
  PQRS_OPEN,
  PQRS_STATUS_LABEL,
  type PqrsRow,
} from '../compliance/shape';
import { listComplianceItems, listPqrs } from '../compliance/store';
import {
  CONTRACT_STATUS_LABEL,
  CONTRACT_TYPE_LABEL,
  type ObligationRow as ContractObligationRow,
  type ContractRow,
  RENEWAL_LABEL,
  canSeeContract,
  contractTerm,
  deriveContractStatus,
} from '../contracts/shape';
import { listObligations as listContractObligations, listContracts } from '../contracts/store';
import { loadPeople } from '../crm/read';
import {
  DEFAULT_STAGES,
  LOST_REASON_LABEL,
  SOURCE_LABEL as OPP_SOURCE_LABEL,
  type OpportunityRow,
  effectiveProbability,
} from '../crm/shape';
import { listOpportunities, loadStages } from '../crm/store';
import { isCompanyManager } from '../directory/store';
import { deriveExpirationStatus } from '../doc-expirations/kinds';
import {
  EXPIRATION_KIND_LABEL,
  STATUS_LABEL as EXPIRATION_STATUS_LABEL,
  SUBJECT_KIND_LABEL,
} from '../doc-expirations/kinds';
import { hydrate, listExpirations } from '../doc-expirations/store';
import { MAINTENANCE_STATUS_LABEL, type MaintenanceStatus } from '../fleet/math';
import { VEHICLE_TYPE_LABEL } from '../fleet/shape';
import { loadFleetOverview } from '../fleet/store';
import { loadInventoryOverview } from '../inventory/products';
import {
  PO_INBOUND,
  PO_STATUS_LABEL,
  type PurchaseOrderRow,
  STOCK_ALERTS,
  STOCK_ALERT_LABEL,
  poLabel,
} from '../inventory/shape';
import { moduleByKey } from '../modules/catalog';
import type { ModuleKey } from '../modules/catalog';
import { isModuleEnabled, moduleOffMessage } from '../modules/store';
import {
  PAYABLE_SOURCE_LABEL,
  PAYABLE_STATUSES,
  PAYABLE_STATUS_LABEL,
  type PayableCheck,
  type PayableInvoiceRow,
  type PayableStatus,
} from '../payables/shape';
import { OPEN_STATUSES } from '../payables/shape';
import { PERIOD_STATUS_LABEL } from '../payroll/shape';
import { listPeriods } from '../payroll/store';
import { PROJECT_KIND_LABEL, PROJECT_STATUS_LABEL } from '../projects/shape';
import { loadProjectsOverview } from '../projects/store';
import { OBLIGATION_KIND_LABEL, OBLIGATION_STATUS_LABEL, isFulfilled } from '../tax/shape';
import { listTaxObligations } from '../tax/store';
import type { TrackerField } from '../trackers/schema';
import { type ViewRow, todayIn } from './compute';
import type { PlatformSource } from './sources';

/**
 * LAS FUENTES DE VISTAS DE LOS MÓDULOS DE OPERACIÓN (0181–0197).
 *
 * Cuentas por pagar, inventario y compras, impuestos, nómina, contratos,
 * cumplimiento, embudo comercial, proyectos, flota y documentos que vencen
 * dejan armar con sus números una vista propia («el programa de pagos de la
 * semana», «lo que está bajo el mínimo»). Cada una lee TAL COMO ESTÁ, con el
 * mismo lector que la pantalla del módulo, y respeta tres reglas:
 *
 *   1. El INTERRUPTOR del módulo (0186). Con el módulo apagado la fuente no se
 *      lee: `withModule` contesta un aviso claro («El módulo X está apagado…»)
 *      y el catálogo del diseñador y del lienzo no la ofrece. No se borra nada:
 *      al prenderlo la vista vuelve a tener datos.
 *
 *   2. QUIÉN MIRA. Todas son `internal` (una vista que las use no se comparte
 *      por enlace). Además, lo confidencial se queda donde la pantalla del
 *      módulo lo deja: la nómina sale SÓLO en agregados por período y sólo
 *      para quien administra la empresa (nunca una fila por persona); un
 *      contrato laboral sólo lo ve quien administra, quien lo creó y su
 *      responsable (contracts/shape.ts); de las PQRS no salen el cuerpo, la
 *      respuesta ni los datos de contacto de quien reclama; de un documento
 *      que vence no sale su título ni su cita (el espacio del Cerebro decide
 *      quién los ve).
 *
 *   3. El dinero de un campo `money` es SIEMPRE pesos: lo que está en otra
 *      moneda va a un campo numérico `*_otra_moneda` (o sólo a «Moneda») y no
 *      se suma con pesos.
 */

// ---------------------------------------------------------------------------
// Piezas (las mismas de sources.ts; aquí van aparte para no importar el
// registro desde el registro)
// ---------------------------------------------------------------------------

const field = (
  key: string,
  label: string,
  type: TrackerField['type'],
  options?: string[],
): TrackerField => ({ key, label, type, required: false, ...(options ? { options } : {}) });

type Values = Record<string, string | number>;

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

const num = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const yesNo = (b: boolean) => (b ? 'Sí' : 'No');
const isCop = (currency: string | null | undefined) =>
  !currency || currency.trim().toUpperCase() === 'COP';

/**
 * Un importe: en pesos va al campo `money`; en otra moneda, al numérico
 * `otherKey` (si lo hay). La moneda se dice siempre.
 */
function putMoney(
  values: Values,
  key: string,
  otherKey: string | null,
  currency: string | null | undefined,
  amount: number | null | undefined,
) {
  put(values, 'moneda', (currency || 'COP').trim().toUpperCase());
  if (amount === null || amount === undefined) return;
  if (isCop(currency)) put(values, key, amount);
  else if (otherKey) put(values, otherKey, amount);
}

const IN_CHUNK = 100;

async function userNames(
  db: SupabaseClient,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('users')
      .select('id, name, email')
      .in('id', unique.slice(i, i + IN_CHUNK));
    if (error) throw error;
    for (const u of (data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      out.set(u.id, u.name?.trim() || u.email);
  }
  return out;
}

/** Lo abierto primero y, si cabe, lo cerrado más reciente: el tope no esconde lo vivo. */
async function openFirst<T>(
  cap: number,
  open: (limit: number) => Promise<T[]>,
  closed: (limit: number) => Promise<T[]>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const opened = await open(cap + 1);
  const rest = opened.length > cap ? [] : await closed(cap + 1 - opened.length);
  const all = [...opened, ...rest];
  return { rows: all.slice(0, cap), truncated: all.length > cap };
}

// ---------------------------------------------------------------------------
// El interruptor
// ---------------------------------------------------------------------------

/**
 * La fuente, detrás del interruptor de su módulo. Se lee el estado en cada
 * lectura (`enabledModules` lo recuerda unos segundos): apagar el módulo
 * apaga también las vistas que ya lo usaban, con un aviso que dice por qué.
 */
export function withModule(key: ModuleKey, source: PlatformSource): PlatformSource {
  const label = moduleByKey(key).label;
  return {
    ...source,
    module: key,
    async read(db, cap, today, ctx) {
      if (!(await isModuleEnabled(db, key)))
        return { rows: [], truncated: false, blocked: moduleOffMessage({ label }) };
      return source.read(db, cap, today, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Cuentas por pagar
// ---------------------------------------------------------------------------

type PayableLite = Pick<
  PayableInvoiceRow,
  | 'id'
  | 'supplier_name'
  | 'doc_number'
  | 'currency'
  | 'issue_date'
  | 'due_date'
  | 'total'
  | 'net_amount'
  | 'status'
  | 'checks'
  | 'scheduled_pay_date'
  | 'paid_at'
  | 'source'
  | 'created_at'
  | 'updated_at'
>;

const PAYABLE_LITE =
  'id, supplier_name, doc_number, currency, issue_date, due_date, total, net_amount, status, checks, scheduled_pay_date, paid_at, source, created_at, updated_at';

const PAYABLE_CLOSED: PayableStatus[] = PAYABLE_STATUSES.filter((s) => !OPEN_STATUSES.includes(s));

/** Lo que la revisión automática dejó para mirar (notas informativas no cuentan). */
function reviewChecks(checks: unknown): PayableCheck[] {
  return (Array.isArray(checks) ? (checks as PayableCheck[]) : []).filter(
    (c) => c.severity === 'warn' || c.severity === 'block',
  );
}

export const porPagarSource: PlatformSource = {
  id: 'cortex.por_pagar',
  name: 'Cuentas por pagar',
  description:
    'Facturas de proveedores: proveedor, número, total y neto de retenciones, cuándo vence, cuándo se programó pagar, estado (por revisar, por aprobar, aprobada, programada, pagada, rechazada) y las alertas de la revisión automática. Lo abierto primero, por vencimiento. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('proveedor', 'Proveedor', 'text'),
    field('numero', 'Número', 'text'),
    field('emision', 'Emitida', 'date'),
    field('vence', 'Vence', 'date'),
    field('dias', 'Días para vencer', 'number'),
    field('pagar_el', 'Pagar el', 'date'),
    field('pagada_el', 'Pagada el', 'date'),
    field('estado', 'Estado', 'select', Object.values(PAYABLE_STATUS_LABEL)),
    field('total', 'Total (COP)', 'money'),
    field('total_otra_moneda', 'Total en otra moneda', 'number'),
    field('neto', 'Neto a pagar (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('alertas', 'Alertas', 'number'),
    field('revision', 'Qué dice la revisión', 'text'),
    field('origen', 'De dónde llegó', 'select', Object.values(PAYABLE_SOURCE_LABEL)),
  ],
  async read(db, cap, today) {
    const query = async (statuses: PayableStatus[], limit: number, open: boolean) => {
      let q = db.from('payable_invoices').select(PAYABLE_LITE).in('status', statuses);
      q = open
        ? q.order('due_date', { ascending: true, nullsFirst: false }).order('issue_date')
        : q.order('updated_at', { ascending: false });
      const { data, error } = await q.limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as PayableLite[];
    };
    const { rows: list, truncated } = await openFirst(
      cap,
      (n) => query([...OPEN_STATUSES], n, true),
      (n) => query(PAYABLE_CLOSED, n, false),
    );
    const rows = list.map((p) => {
      const v: Values = {};
      const open = (OPEN_STATUSES as readonly string[]).includes(p.status);
      const alerts = reviewChecks(p.checks);
      put(v, 'proveedor', p.supplier_name);
      put(v, 'numero', p.doc_number);
      put(v, 'emision', dayOf(p.issue_date));
      put(v, 'vence', dayOf(p.due_date));
      if (open && p.due_date) put(v, 'dias', daysBetween(today, p.due_date));
      put(v, 'pagar_el', dayOf(p.scheduled_pay_date));
      put(v, 'pagada_el', dayOf(p.paid_at));
      put(v, 'estado', PAYABLE_STATUS_LABEL[p.status] ?? p.status);
      putMoney(v, 'total', 'total_otra_moneda', p.currency, num(p.total));
      if (isCop(p.currency)) put(v, 'neto', num(p.net_amount));
      put(v, 'alertas', alerts.length);
      put(
        v,
        'revision',
        [...alerts]
          .sort((a, b) => (a.severity === 'block' ? 0 : 1) - (b.severity === 'block' ? 0 : 1))[0]
          ?.message?.slice(0, 200),
      );
      put(v, 'origen', PAYABLE_SOURCE_LABEL[p.source] ?? p.source);
      return row(p.id, `${p.supplier_name} · ${p.doc_number}`, v, p.created_at, p.updated_at);
    });
    return { rows, truncated };
  },
};

// ---------------------------------------------------------------------------
// Inventario y órdenes de compra
// ---------------------------------------------------------------------------

const ALERT_RANK = new Map<string, number>(STOCK_ALERTS.map((a, i) => [a, i]));

export const inventarioSource: PlatformSource = {
  id: 'cortex.inventario',
  name: 'Inventario',
  description:
    'Productos activos con su existencia total, el mínimo, cuánto falta para llegar al mínimo, cuánto dura al ritmo de las salidas, costo, precio y valor en bodega, y la alerta (agotado, bajo el mínimo, se agota antes de reponer, sin movimiento). Lo que necesita atención primero. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('sku', 'Código', 'text'),
    field('categoria', 'Categoría', 'text'),
    field('unidad', 'Unidad', 'text'),
    field('existencia', 'Existencia', 'number'),
    field('minimo', 'Mínimo', 'number'),
    field('faltante', 'Falta para el mínimo', 'number'),
    field('reposicion', 'Cantidad a reponer', 'number'),
    field('alerta', 'Alerta', 'select', Object.values(STOCK_ALERT_LABEL)),
    field('dias_cobertura', 'Días que alcanza', 'number'),
    field('consumo_diario', 'Salidas por día', 'number'),
    field('costo', 'Costo promedio (COP)', 'money'),
    field('precio', 'Precio de venta (COP)', 'money'),
    field('valor', 'Valor en bodega (COP)', 'money'),
    field('moneda', 'Moneda', 'text'),
    field('ultimo_movimiento', 'Último movimiento', 'date'),
    field('proveedor', 'Proveedor preferido', 'text'),
  ],
  async read(db, cap, today) {
    const overview = await loadInventoryOverview(db, { today });
    const sorted = [...overview.products].sort(
      (a, b) =>
        (ALERT_RANK.get(a.alert) ?? 99) - (ALERT_RANK.get(b.alert) ?? 99) ||
        a.name.localeCompare(b.name, 'es'),
    );
    const rows = sorted.slice(0, cap).map((p) => {
      const v: Values = {};
      put(v, 'sku', p.sku);
      put(v, 'categoria', p.category);
      put(v, 'unidad', p.unit);
      if (p.trackStock) {
        put(v, 'existencia', p.onHand);
        put(v, 'minimo', p.minStock);
        if (p.minStock !== null && p.onHand !== null)
          put(v, 'faltante', Math.max(0, p.minStock - p.onHand));
        put(v, 'reposicion', p.reorderQty);
        put(v, 'dias_cobertura', p.daysOfCover);
        put(v, 'consumo_diario', Math.round(p.dailyUse * 100) / 100);
        put(v, 'ultimo_movimiento', dayOf(p.lastMovementOn));
      }
      put(v, 'alerta', STOCK_ALERT_LABEL[p.alert]);
      put(v, 'moneda', p.currency);
      // Sólo en pesos: un costo en dólares no se pinta como COP.
      if (isCop(p.currency)) {
        put(v, 'costo', p.cost);
        put(v, 'precio', p.price);
        put(v, 'valor', p.value);
      }
      put(v, 'proveedor', p.supplierName);
      return row(p.id, p.name, v, null);
    });
    return { rows, truncated: sorted.length > cap };
  },
};

type OrderLite = Pick<
  PurchaseOrderRow,
  | 'id'
  | 'number'
  | 'supplier_name'
  | 'status'
  | 'currency'
  | 'total'
  | 'expected_on'
  | 'payment_terms_days'
  | 'origin'
  | 'received_at'
  | 'created_at'
  | 'updated_at'
>;

const ORDER_LITE =
  'id, number, supplier_name, status, currency, total, expected_on, payment_terms_days, origin, received_at, created_at, updated_at';
const ORDER_OPEN = ['borrador', 'por_aprobar', 'aprobada', 'enviada', 'recibida_parcial'];
const ORDER_CLOSED = ['recibida', 'facturada', 'cerrada', 'cancelada'];
const ORDER_ORIGIN_LABEL: Record<PurchaseOrderRow['origin'], string> = {
  manual: 'A mano',
  sugerencia: 'Sugerencia de reposición',
  chat: 'Chat',
  piloto: 'Piloto automático',
};

export const ordenesCompraSource: PlatformSource = {
  id: 'cortex.ordenes_compra',
  name: 'Órdenes de compra',
  description:
    'Órdenes de compra a proveedores: número, proveedor, estado (borrador, por aprobar, aprobada, enviada, recibida en parte, recibida, facturada, cerrada, cancelada), cuándo se espera la mercancía, si va atrasada y el total. Lo abierto primero. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('proveedor', 'Proveedor', 'text'),
    field('estado', 'Estado', 'select', Object.values(PO_STATUS_LABEL)),
    field('creada', 'Creada', 'date'),
    field('esperada', 'Se espera el', 'date'),
    field('recibida', 'Recibida el', 'date'),
    field('dias_para_llegar', 'Días para que llegue', 'number'),
    field('atrasada', 'Atrasada', 'select', ['Sí', 'No']),
    field('total', 'Total (COP)', 'money'),
    field('total_otra_moneda', 'Total en otra moneda', 'number'),
    field('moneda', 'Moneda', 'text'),
    field('plazo_dias', 'Plazo de pago (días)', 'number'),
    field('origen', 'Cómo se creó', 'select', Object.values(ORDER_ORIGIN_LABEL)),
  ],
  async read(db, cap, today) {
    const query = async (statuses: string[], limit: number, open: boolean) => {
      let q = db.from('purchase_orders').select(ORDER_LITE).in('status', statuses);
      q = open
        ? q.order('expected_on', { ascending: true, nullsFirst: false })
        : q.order('number', { ascending: false });
      const { data, error } = await q.limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as OrderLite[];
    };
    const { rows: list, truncated } = await openFirst(
      cap,
      (n) => query(ORDER_OPEN, n, true),
      (n) => query(ORDER_CLOSED, n, false),
    );
    const rows = list.map((o) => {
      const v: Values = {};
      const inbound = (PO_INBOUND as readonly string[]).includes(o.status);
      put(v, 'proveedor', o.supplier_name);
      put(v, 'estado', PO_STATUS_LABEL[o.status] ?? o.status);
      put(v, 'creada', dayOf(o.created_at));
      put(v, 'esperada', dayOf(o.expected_on));
      put(v, 'recibida', dayOf(o.received_at));
      if (inbound && o.expected_on) {
        const left = daysBetween(today, o.expected_on);
        put(v, 'dias_para_llegar', left);
        put(v, 'atrasada', yesNo(left < 0));
      } else put(v, 'atrasada', 'No');
      putMoney(v, 'total', 'total_otra_moneda', o.currency, num(o.total));
      put(v, 'plazo_dias', o.payment_terms_days);
      put(v, 'origen', ORDER_ORIGIN_LABEL[o.origin] ?? o.origin);
      return row(o.id, `${poLabel(o.number)} · ${o.supplier_name}`, v, o.created_at, o.updated_at);
    });
    return { rows, truncated };
  },
};

// ---------------------------------------------------------------------------
// Impuestos
// ---------------------------------------------------------------------------

export const impuestosSource: PlatformSource = {
  id: 'cortex.impuestos',
  name: 'Calendario tributario',
  description:
    'Obligaciones tributarias de la empresa (renta, IVA, retención, ICA, exógena, PILA, matrícula mercantil…): obligación, período, entidad, cuándo vence, cuántos días faltan, estado (pendiente, presentada, pagada, no aplica) y si ya está vencida. Por fecha de vencimiento. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('tipo', 'Impuesto', 'select', Object.values(OBLIGATION_KIND_LABEL)),
    field('periodo', 'Período', 'text'),
    field('entidad', 'Entidad', 'text'),
    field('formulario', 'Formulario', 'text'),
    field('vence', 'Vence', 'date'),
    field('dias', 'Días para vencer', 'number'),
    field('estado', 'Estado', 'select', Object.values(OBLIGATION_STATUS_LABEL)),
    field('vencida', 'Vencida', 'select', ['Sí', 'No']),
    field('requiere_pago', 'Requiere pago', 'select', ['Sí', 'No']),
    field('por_confirmar', 'Fecha por confirmar', 'select', ['Sí', 'No']),
    field('registrada', 'Estado cambiado el', 'date'),
  ],
  async read(db, cap, today) {
    const list = await listTaxObligations(db, { limit: cap + 1 });
    const rows = list.slice(0, cap).map((o) => {
      const v: Values = {};
      const fulfilled = isFulfilled(o.status, o.requiresPayment);
      put(v, 'tipo', OBLIGATION_KIND_LABEL[o.kind] ?? o.kind);
      put(v, 'periodo', o.period);
      put(v, 'entidad', o.authority);
      put(v, 'formulario', o.form);
      put(v, 'vence', o.dueDate);
      if (!fulfilled) put(v, 'dias', daysBetween(today, o.dueDate));
      put(v, 'estado', OBLIGATION_STATUS_LABEL[o.status] ?? o.status);
      put(v, 'vencida', yesNo(!fulfilled && o.dueDate < today));
      put(v, 'requiere_pago', yesNo(o.requiresPayment));
      put(v, 'por_confirmar', yesNo(o.needsConfirmation));
      put(v, 'registrada', dayOf(o.statusAt));
      return row(o.id, o.title, v, o.statusAt ?? `${o.dueDate}T00:00:00Z`);
    });
    return { rows, truncated: list.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Nómina: SÓLO agregados por período
// ---------------------------------------------------------------------------

export const NOMINA_RESTRICTED =
  'La nómina es confidencial: sólo la ven quienes administran la empresa.';

const PERIOD_FREQUENCY = ['Mensual', 'Quincenal'];

/**
 * Una fila por período de nómina con los TOTALES que la liquidación guardó en
 * el período (`payroll_periods.totals`). Nunca lee empleados, desprendibles ni
 * novedades: no hay forma de que una vista saque lo que gana una persona. Y
 * sólo la ve quien administra la empresa (`isCompanyManager`, igual que las
 * pantallas de nómina); para cualquier otra persona, o sin sesión, la fuente
 * no se lee y el bloque dice por qué.
 */
export const nominaSource: PlatformSource = {
  id: 'cortex.nomina',
  name: 'Nómina por período',
  description:
    'SÓLO totales por período de nómina (nunca por persona): total devengado, deducciones, aportes del empleador, provisiones, neto a pagar, costo total, seguridad social, número de personas, estado y fecha de pago. Sólo para quien administra la empresa. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('periodo', 'Período', 'text'),
    field('inicio', 'Desde', 'date'),
    field('fin', 'Hasta', 'date'),
    field('pago', 'Fecha de pago', 'date'),
    field('frecuencia', 'Frecuencia', 'select', PERIOD_FREQUENCY),
    field('estado', 'Estado', 'select', Object.values(PERIOD_STATUS_LABEL)),
    field('personas', 'Personas', 'number'),
    field('devengado', 'Total devengado (COP)', 'money'),
    field('deducciones', 'Deducciones (COP)', 'money'),
    field('aportes', 'Aportes del empleador (COP)', 'money'),
    field('provisiones', 'Provisiones (COP)', 'money'),
    field('neto', 'Neto a pagar (COP)', 'money'),
    field('costo_total', 'Costo total para la empresa (COP)', 'money'),
    field('seguridad_social', 'Seguridad social / PILA (COP)', 'money'),
  ],
  async read(db, cap, _today, ctx) {
    if (!(await isCompanyManager(db, ctx.viewerId)))
      return { rows: [], truncated: false, blocked: NOMINA_RESTRICTED };
    const periods = await listPeriods(db, { limit: cap + 1 });
    const rows = periods.slice(0, cap).map((p) => {
      const v: Values = {};
      put(v, 'periodo', p.label);
      put(v, 'inicio', p.start);
      put(v, 'fin', p.end);
      put(v, 'pago', p.payDate);
      put(v, 'frecuencia', p.frequency === 'mensual' ? 'Mensual' : 'Quincenal');
      put(v, 'estado', PERIOD_STATUS_LABEL[p.status] ?? p.status);
      put(v, 'personas', p.employeesCount || p.totals.employees);
      put(v, 'devengado', p.totals.devengado);
      put(v, 'deducciones', p.totals.deducciones);
      put(v, 'aportes', p.totals.aportes);
      put(v, 'provisiones', p.totals.provisiones);
      put(v, 'neto', p.totals.neto);
      put(v, 'costo_total', p.totals.costoTotal);
      put(v, 'seguridad_social', p.totals.seguridadSocial);
      return row(p.id, p.label, v, `${p.start}T00:00:00Z`, p.liquidatedAt ?? undefined);
    });
    return { rows, truncated: periods.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

const CONTRACT_OPEN_STATES = new Set(['firmado', 'vigente', 'vencido']);

export const contratosSource: PlatformSource = {
  id: 'cortex.contratos',
  name: 'Contratos',
  description:
    'Contratos de la empresa: tipo, contraparte, valor, vigencia (con las renovaciones automáticas ya corridas), hasta qué día se puede avisar que no se renueva, estado y la próxima obligación confirmada. Los contratos laborales sólo salen para quien administra la empresa, quien los creó y su responsable. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('tipo', 'Tipo', 'select', Object.values(CONTRACT_TYPE_LABEL)),
    field('contraparte', 'Contraparte', 'text'),
    field('valor', 'Valor (COP)', 'money'),
    field('valor_otra_moneda', 'Valor en otra moneda', 'number'),
    field('moneda', 'Moneda', 'text'),
    field('inicio', 'Inicio', 'date'),
    field('vence', 'Vence (período en curso)', 'date'),
    field('dias_para_vencer', 'Días para vencer', 'number'),
    field('aviso_hasta', 'Avisar a más tardar', 'date'),
    field('dias_para_aviso', 'Días para el aviso', 'number'),
    field('renovacion', 'Renovación', 'select', Object.values(RENEWAL_LABEL)),
    field('estado', 'Estado', 'select', Object.values(CONTRACT_STATUS_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('proxima_obligacion', 'Próxima obligación', 'text'),
    field('proxima_obligacion_vence', 'Vence la obligación', 'date'),
    field('obligaciones_pendientes', 'Obligaciones por cumplir', 'number'),
    field('obligaciones_vencidas', 'Obligaciones vencidas', 'number'),
  ],
  async read(db, cap, today, ctx) {
    const [raw, manager] = await Promise.all([
      listContracts(db, { limit: cap + 1 }),
      isCompanyManager(db, ctx.viewerId),
    ]);
    // Quien no se sabe quién es (Inicio sin sesión) ve lo que no es laboral:
    // `canSeeContract` con un id que no es de nadie.
    const viewer = { userId: ctx.viewerId ?? '', manager };
    const visible = raw.slice(0, cap).filter((c: ContractRow) => canSeeContract(c, viewer));
    const ids = new Set(visible.map((c) => c.id));
    // Las obligaciones de los contratos que no se ven no se leen para nadie.
    const obligations = (
      await listContractObligations(db, { statuses: ['confirmada'], limit: 2000 })
    ).filter((o) => ids.has(o.contract_id));
    const byContract = new Map<string, ContractObligationRow[]>();
    for (const o of obligations) {
      const list = byContract.get(o.contract_id) ?? [];
      list.push(o);
      byContract.set(o.contract_id, list);
    }
    const names = await userNames(
      db,
      visible.map((c) => c.owner_user_id),
    );
    const rows = visible.map((c) => {
      const v: Values = {};
      const state = deriveContractStatus(c, today);
      const term = contractTerm(c, today);
      const own = c.status === 'terminado' ? [] : (byContract.get(c.id) ?? []);
      const next = own.find((o) => o.due_on);
      put(v, 'tipo', CONTRACT_TYPE_LABEL[c.contract_type] ?? c.contract_type);
      put(v, 'contraparte', c.counterparty_name);
      putMoney(v, 'valor', 'valor_otra_moneda', c.currency, num(c.value_amount));
      put(v, 'inicio', c.start_on);
      if (CONTRACT_OPEN_STATES.has(state)) {
        put(v, 'vence', term.currentEnd);
        put(v, 'dias_para_vencer', term.daysToEnd);
        put(v, 'aviso_hasta', term.noticeDeadline);
        put(v, 'dias_para_aviso', term.daysToNotice);
      }
      put(v, 'renovacion', RENEWAL_LABEL[c.renewal] ?? c.renewal);
      put(v, 'estado', CONTRACT_STATUS_LABEL[state] ?? state);
      put(v, 'responsable', c.owner_user_id ? names.get(c.owner_user_id) : null);
      put(v, 'proxima_obligacion', next?.description.slice(0, 160));
      put(v, 'proxima_obligacion_vence', next?.due_on);
      put(v, 'obligaciones_pendientes', own.length);
      put(v, 'obligaciones_vencidas', own.filter((o) => o.due_on && o.due_on < today).length);
      return row(c.id, c.title, v, c.created_at, c.updated_at);
    });
    return { rows, truncated: raw.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Cumplimiento: PQRS y lista de cumplimiento
// ---------------------------------------------------------------------------

export const pqrsSource: PlatformSource = {
  id: 'cortex.pqrs',
  name: 'PQRS',
  description:
    'Peticiones, quejas, reclamos y sugerencias recibidas: radicado, clase, materia, canal, asunto, cuándo se recibió, plazo legal de respuesta con los días hábiles que quedan, estado y responsable. No trae el texto de la solicitud, la respuesta ni los datos de contacto de quien la envió. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('radicado', 'Radicado', 'text'),
    field('clase', 'Clase', 'select', Object.values(PQRS_KIND_LABEL)),
    field('materia', 'Materia', 'select', Object.values(PQRS_MATTER_LABEL)),
    field('canal', 'Canal', 'select', Object.values(PQRS_CHANNEL_LABEL)),
    field('asunto', 'Asunto', 'text'),
    field('recibida', 'Recibida el', 'date'),
    field('vence', 'Responder antes del', 'date'),
    field('dias_habiles', 'Días hábiles que quedan', 'number'),
    field('vencida', 'Fuera de plazo', 'select', ['Sí', 'No']),
    field('estado', 'Estado', 'select', Object.values(PQRS_STATUS_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('respondida', 'Respondida el', 'date'),
  ],
  async read(db, cap, today) {
    const list = (await listPqrs(db, { limit: cap + 1 })) as PqrsRow[];
    const page = list.slice(0, cap);
    const names = await userNames(
      db,
      page.map((p) => p.assigned_user_id),
    );
    const rows = page.map((p) => {
      const v: Values = {};
      const open = (PQRS_OPEN as readonly string[]).includes(p.status);
      const due = p.extended_due_on ?? p.due_on;
      put(v, 'radicado', p.radicado);
      put(v, 'clase', PQRS_KIND_LABEL[p.kind] ?? p.kind);
      put(v, 'materia', PQRS_MATTER_LABEL[p.matter] ?? p.matter);
      put(v, 'canal', PQRS_CHANNEL_LABEL[p.channel] ?? p.channel);
      put(v, 'asunto', p.subject.slice(0, 200));
      put(v, 'recibida', dayOf(p.received_on) ?? dayOf(p.received_at));
      put(v, 'vence', due);
      if (open) put(v, 'dias_habiles', businessDaysLeft(today, due));
      put(v, 'vencida', yesNo(open && due < today));
      put(v, 'estado', PQRS_STATUS_LABEL[p.status] ?? p.status);
      put(v, 'responsable', p.assigned_user_id ? names.get(p.assigned_user_id) : null);
      put(v, 'respondida', dayOf(p.responded_at));
      return row(p.id, `${p.radicado} · ${p.subject.slice(0, 80)}`, v, p.received_at, p.updated_at);
    });
    return { rows, truncated: list.length > cap };
  },
};

export const cumplimientoSource: PlatformSource = {
  id: 'cortex.cumplimiento',
  name: 'Lista de cumplimiento',
  description:
    'Obligaciones de cumplimiento de la empresa (societario, datos personales SIC, consumidor, lavado de activos, transparencia): obligación, área, frecuencia, período, cuándo vence, estado (pendiente, en curso, cumplido, no aplica), si le aplica a la empresa, base legal y responsable. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('area', 'Área', 'select', Object.values(COMPLIANCE_AREA_LABEL)),
    field('frecuencia', 'Frecuencia', 'select', Object.values(ITEM_FREQUENCY_LABEL)),
    field('periodo', 'Período', 'text'),
    field('vence', 'Vence', 'date'),
    field('dias', 'Días para vencer', 'number'),
    field('estado', 'Estado', 'select', Object.values(ITEM_STATUS_LABEL)),
    field('vencida', 'Vencida', 'select', ['Sí', 'No']),
    field('aplica', 'Le aplica a la empresa', 'select', ['Sí', 'No', 'Por revisar']),
    field('por_confirmar', 'Fecha por confirmar', 'select', ['Sí', 'No']),
    field('base_legal', 'Base legal', 'text'),
    field('responsable', 'Responsable', 'text'),
    field('cumplida', 'Cumplida el', 'date'),
  ],
  async read(db, cap, today) {
    const list = (await listComplianceItems(db, { limit: cap + 1 })) as ComplianceItemRow[];
    const page = list.slice(0, cap);
    const names = await userNames(
      db,
      page.map((i) => i.owner_user_id),
    );
    const APPLIES = { si: 'Sí', no: 'No', revisar: 'Por revisar' } as const;
    const rows = page.map((i) => {
      const v: Values = {};
      const pending = i.status === 'pendiente' || i.status === 'en_curso';
      put(v, 'area', COMPLIANCE_AREA_LABEL[i.area] ?? i.area);
      put(v, 'frecuencia', ITEM_FREQUENCY_LABEL[i.frequency] ?? i.frequency);
      put(v, 'periodo', i.period);
      put(v, 'vence', i.due_on);
      if (pending && i.due_on) put(v, 'dias', daysBetween(today, i.due_on));
      put(v, 'estado', ITEM_STATUS_LABEL[i.status] ?? i.status);
      put(v, 'vencida', yesNo(pending && i.applies !== 'no' && !!i.due_on && i.due_on < today));
      put(v, 'aplica', APPLIES[i.applies] ?? i.applies);
      put(v, 'por_confirmar', yesNo(i.due_needs_confirmation));
      put(v, 'base_legal', i.legal_basis?.slice(0, 200));
      put(v, 'responsable', i.owner_user_id ? names.get(i.owner_user_id) : null);
      put(v, 'cumplida', dayOf(i.completed_at));
      return row(i.id, i.title, v, i.created_at, i.updated_at);
    });
    return { rows, truncated: list.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Embudo comercial
// ---------------------------------------------------------------------------

const OPP_STATE = ['Abierta', 'Ganada', 'Perdida'];

export const comercialSource: PlatformSource = {
  id: 'cortex.comercial',
  name: 'Embudo comercial',
  description:
    'Oportunidades del embudo: oportunidad, cliente, etapa, estado (abierta, ganada, perdida), valor, probabilidad, valor ponderado, cierre esperado, responsable, próximo paso y días sin actividad. La etapa usa los nombres del embudo estándar; si la empresa cambió sus etapas, las que no coinciden salen en «Sin estado» de un tablero. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('cliente', 'Cliente', 'text'),
    field(
      'etapa',
      'Etapa',
      'select',
      DEFAULT_STAGES.map((s) => s.label),
    ),
    field('estado', 'Estado', 'select', OPP_STATE),
    field('valor', 'Valor (COP)', 'money'),
    field('valor_otra_moneda', 'Valor en otra moneda', 'number'),
    field('moneda', 'Moneda', 'text'),
    field('probabilidad', 'Probabilidad (%)', 'number'),
    field('ponderado', 'Valor ponderado (COP)', 'money'),
    field('cierre_esperado', 'Cierre esperado', 'date'),
    field('responsable', 'Responsable', 'text'),
    field('proximo_paso', 'Próximo paso', 'text'),
    field('proximo_paso_vence', 'Para cuándo', 'date'),
    field('dias_sin_actividad', 'Días sin actividad', 'number'),
    field('origen', 'Origen', 'select', Object.values(OPP_SOURCE_LABEL)),
    field('ganada', 'Ganada el', 'date'),
    field('perdida', 'Perdida el', 'date'),
    field('motivo_perdida', 'Por qué se perdió', 'select', Object.values(LOST_REASON_LABEL)),
  ],
  async read(db, cap, today) {
    const [{ stages }, people, list] = await Promise.all([
      loadStages(db),
      loadPeople(db).catch(() => new Map<string, string>()),
      // Lo abierto y lo cerrado, lo último tocado primero.
      listOpportunities(db, { includeClosed: true, limit: cap + 1 }),
    ]);
    const stageLabel = new Map(stages.map((s) => [s.key, s.label]));
    const page: OpportunityRow[] = list.slice(0, cap);
    const rows = page.map((o) => {
      const v: Values = {};
      const state = o.won_at ? 'Ganada' : o.lost_at ? 'Perdida' : 'Abierta';
      const prob = effectiveProbability(o, stages);
      put(v, 'cliente', o.client_name);
      put(v, 'etapa', stageLabel.get(o.stage) ?? o.stage);
      put(v, 'estado', state);
      putMoney(v, 'valor', 'valor_otra_moneda', o.currency, o.value);
      if (isCop(o.currency) && state === 'Abierta')
        put(v, 'ponderado', Math.round((o.value * prob) / 100));
      put(v, 'probabilidad', prob);
      put(v, 'cierre_esperado', dayOf(o.expected_close));
      put(v, 'responsable', o.owner_user_id ? people.get(o.owner_user_id) : null);
      put(v, 'proximo_paso', o.next_step?.slice(0, 200));
      put(v, 'proximo_paso_vence', dayOf(o.next_step_due));
      if (state === 'Abierta' && o.last_activity_at)
        put(
          v,
          'dias_sin_actividad',
          Math.max(0, -daysBetween(today, dayOf(o.last_activity_at) ?? today)),
        );
      put(v, 'origen', OPP_SOURCE_LABEL[o.source] ?? o.source);
      put(v, 'ganada', dayOf(o.won_at));
      put(v, 'perdida', dayOf(o.lost_at));
      put(v, 'motivo_perdida', o.lost_reason_kind ? LOST_REASON_LABEL[o.lost_reason_kind] : null);
      return row(o.id, o.title, v, o.created_at, o.updated_at);
    });
    return { rows, truncated: list.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Proyectos y órdenes de servicio
// ---------------------------------------------------------------------------

export const proyectosSource: PlatformSource = {
  id: 'cortex.proyectos',
  name: 'Proyectos y órdenes de servicio',
  description:
    'Proyectos y órdenes de servicio (el nombre de la fila lleva el código): cliente, estado, responsable, fecha de entrega, avance por tareas, horas usadas contra las presupuestadas, costo contra el presupuesto, lo facturado y lo que falta por facturar, el margen y las alertas. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('tipo', 'Tipo', 'select', Object.values(PROJECT_KIND_LABEL)),
    field('cliente', 'Cliente', 'text'),
    field('estado', 'Estado', 'select', Object.values(PROJECT_STATUS_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('entrega', 'Entrega', 'date'),
    field('dias_para_entrega', 'Días para la entrega', 'number'),
    field('avance', 'Avance (%)', 'number'),
    field('tareas_tarde', 'Tareas tarde', 'number'),
    field('horas', 'Horas usadas', 'number'),
    field('horas_pct', 'Horas usadas (% del presupuesto)', 'number'),
    field('costo', 'Costo acumulado (COP)', 'money'),
    field('presupuesto', 'Presupuesto (COP)', 'money'),
    field('costo_pct', 'Costo (% del presupuesto)', 'number'),
    field('ingreso', 'Ingreso esperado (COP)', 'money'),
    field('facturado', 'Facturado (COP)', 'money'),
    field('por_facturar', 'Por facturar (COP)', 'money'),
    field('margen', 'Margen (COP)', 'money'),
    field('margen_pct', 'Margen (%)', 'number'),
    field('moneda', 'Moneda', 'text'),
    field('alerta', 'Alerta principal', 'text'),
  ],
  async read(db, cap, today) {
    const { projects } = await loadProjectsOverview(db, today, { limit: cap + 1 });
    const rows = projects.slice(0, cap).map(({ project: p, metrics: m, ownerName }) => {
      const v: Values = {};
      const active = p.status === 'abierto' || p.status === 'en_curso' || p.status === 'en_pausa';
      put(v, 'tipo', PROJECT_KIND_LABEL[p.kind] ?? p.kind);
      put(v, 'cliente', p.client_name);
      put(v, 'estado', PROJECT_STATUS_LABEL[p.status] ?? p.status);
      put(v, 'responsable', ownerName);
      put(v, 'entrega', p.due_on);
      if (active && p.due_on) put(v, 'dias_para_entrega', daysBetween(today, p.due_on));
      put(v, 'avance', m.progress.pct);
      put(v, 'tareas_tarde', m.progress.lateTasks);
      put(v, 'horas', m.hours.used);
      put(v, 'horas_pct', m.hours.pct);
      put(v, 'costo_pct', m.costs.pct);
      put(v, 'margen_pct', m.margin.pct);
      put(v, 'moneda', (p.currency || 'COP').toUpperCase());
      // Sólo en pesos: las cifras de un proyecto en otra moneda no entran en
      // un campo que se pinta como COP.
      if (isCop(p.currency)) {
        put(v, 'costo', m.costs.total);
        put(v, 'presupuesto', m.costs.budget);
        put(v, 'ingreso', m.revenue.amount);
        put(v, 'facturado', m.revenue.invoiced);
        put(v, 'por_facturar', m.revenue.unbilled);
        put(v, 'margen', m.margin.amount);
      }
      put(v, 'alerta', m.alerts[0]?.message?.slice(0, 200));
      return row(p.id, `${p.code} · ${p.title}`, v, p.created_at, p.updated_at);
    });
    return { rows, truncated: projects.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Flota
// ---------------------------------------------------------------------------

const MAINTENANCE_RANK: Record<MaintenanceStatus, number> = {
  vencido: 0,
  pronto: 1,
  sin_base: 2,
  al_dia: 3,
};

export const flotaSource: PlatformSource = {
  id: 'cortex.flota',
  name: 'Flota',
  description:
    'Vehículos de la flota: placa, tipo, conductor, kilometraje, costo por kilómetro de los últimos 90 días, rendimiento de combustible, utilización, el mantenimiento más urgente (qué es, para cuándo o a qué kilometraje), SOAT y tecnomecánica, documentos por vencer y comparendos. Los que necesitan atención primero. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('vehiculo', 'Vehículo', 'text'),
    field('tipo', 'Tipo', 'select', Object.values(VEHICLE_TYPE_LABEL)),
    field('conductor', 'Conductor', 'text'),
    field('km', 'Kilometraje', 'number'),
    field('costo_km', 'Costo por km (COP)', 'money'),
    field('costo_90d', 'Costo en 90 días (COP)', 'money'),
    field('km_galon', 'Km por galón', 'number'),
    field('utilizacion', 'Utilización 30 días (%)', 'number'),
    field('mantenimiento', 'Mantenimiento más urgente', 'text'),
    field('mantenimiento_estado', 'Estado del mantenimiento', 'select', [
      ...Object.values(MAINTENANCE_STATUS_LABEL),
    ]),
    field('mantenimiento_fecha', 'Mantenimiento para el', 'date'),
    field('mantenimiento_km', 'Mantenimiento a los km', 'number'),
    field('soat_vence', 'SOAT vence', 'date'),
    field('tecnomecanica_vence', 'Tecnomecánica vence', 'date'),
    field('documentos_por_vencer', 'Documentos vencidos o por vencer', 'number'),
    field('comparendos', 'Comparendos pendientes (COP)', 'money'),
    field('atencion', 'Qué necesita atención', 'text'),
  ],
  async read(db, cap, today) {
    const overview = await loadFleetOverview(db, today);
    const sorted = [...overview.vehicles].sort(
      (a, b) => b.attention.length - a.attention.length || a.row.plate.localeCompare(b.row.plate),
    );
    const rows = sorted.slice(0, cap).map((vw) => {
      const v: Values = {};
      const r = vw.row;
      const worst = [...vw.plans].sort(
        (a, b) =>
          MAINTENANCE_RANK[a.due.status] - MAINTENANCE_RANK[b.due.status] ||
          (a.due.nextOn ?? '9999').localeCompare(b.due.nextOn ?? '9999'),
      )[0];
      const doc = (kind: string) => vw.documents.find((d) => d.kind === kind)?.expiresOn ?? null;
      put(v, 'vehiculo', [r.plate, r.brand, r.line].filter(Boolean).join(' · '));
      put(v, 'tipo', r.vehicle_type ? VEHICLE_TYPE_LABEL[r.vehicle_type] : null);
      put(v, 'conductor', vw.driver);
      put(v, 'km', vw.odometerKm);
      put(v, 'costo_km', vw.cost.perKm);
      put(v, 'costo_90d', vw.cost.total);
      put(v, 'km_galon', vw.fuel.kmPerGallon);
      put(v, 'utilizacion', vw.utilization.pct);
      if (worst) {
        put(v, 'mantenimiento', worst.task);
        put(v, 'mantenimiento_estado', MAINTENANCE_STATUS_LABEL[worst.due.status]);
        put(v, 'mantenimiento_fecha', worst.due.nextOn);
        put(v, 'mantenimiento_km', worst.due.nextKm);
      }
      put(v, 'soat_vence', dayOf(doc('soat')));
      put(v, 'tecnomecanica_vence', dayOf(doc('tecnomecanica')));
      put(
        v,
        'documentos_por_vencer',
        vw.documents.filter((d) => d.expiry.status === 'expired' || d.expiry.status === 'expiring')
          .length,
      );
      put(v, 'comparendos', num(r.total_pending_cop));
      put(v, 'atencion', vw.attention.slice(0, 3).join('; '));
      return row(r.id, r.plate + (r.label ? ` · ${r.label}` : ''), v, r.created_at);
    });
    return { rows, truncated: sorted.length > cap };
  },
};

// ---------------------------------------------------------------------------
// Documentos que vencen
// ---------------------------------------------------------------------------

export const documentosVencenSource: PlatformSource = {
  id: 'cortex.documentos_vencen',
  name: 'Documentos que vencen',
  description:
    'Papeles de la empresa que vencen y hay que renovar (SOAT, tecnomecánica, pólizas, licencias, permisos, habilitaciones, certificados, contratos con clientes), SÓLO los ya confirmados por una persona: tipo, a quién o a qué pertenecen, cuándo vencen, estado (vigente, por vencer, vencido) y responsable. No trae el documento ni su cita. Por fecha de vencimiento. Interno: no se comparte por enlace.',
  sensitivity: 'internal',
  fields: [
    field('tipo', 'Tipo', 'select', Object.values(EXPIRATION_KIND_LABEL)),
    field('sujeto', 'De quién o de qué', 'text'),
    field('clase_sujeto', 'Clase de sujeto', 'select', Object.values(SUBJECT_KIND_LABEL)),
    field('emisor', 'Emisor', 'text'),
    field('vence', 'Vence', 'date'),
    field('dias', 'Días para vencer', 'number'),
    field('estado', 'Estado', 'select', Object.values(EXPIRATION_STATUS_LABEL)),
    field('responsable', 'Responsable', 'text'),
    field('aviso_dias', 'Renovar con (días de anticipación)', 'number'),
  ],
  async read(db, cap, today) {
    // Sólo lo confirmado: lo propuesto por la lectura de un documento todavía
    // no se vigila, y una vista no lo cuenta como si lo estuviera.
    const raw = await listExpirations(db, { needsReview: false, limit: cap + 1 });
    const list = await hydrate(db, raw.slice(0, cap));
    const rows = list.map((e) => {
      const v: Values = {};
      const state = deriveExpirationStatus(e, today);
      put(v, 'tipo', EXPIRATION_KIND_LABEL[e.kind] ?? e.kind);
      put(v, 'sujeto', e.subject ?? e.vehicle_plate ?? e.client_name);
      put(v, 'clase_sujeto', SUBJECT_KIND_LABEL[e.subject_kind] ?? e.subject_kind);
      put(v, 'emisor', e.issuer);
      put(v, 'vence', e.expires_on);
      if (e.expires_on && state !== 'renovado' && state !== 'descartado')
        put(v, 'dias', daysBetween(today, e.expires_on));
      put(v, 'estado', EXPIRATION_STATUS_LABEL[state]);
      put(v, 'responsable', e.owner_name);
      put(v, 'aviso_dias', e.renewal_lead_days);
      // Ni título del documento ni cita: el espacio del Cerebro decide quién
      // los ve, y una vista no tiene cómo preguntárselo a cada espectador.
      return row(e.id, e.title, v, e.created_at, e.updated_at);
    });
    return { rows, truncated: raw.length > cap };
  },
};
