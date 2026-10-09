import { longDate, shortDate } from '../actions/draft';
import { type SnapshotBudget, collectPresupuesto } from '../budget/autopilot-collect';
import { type SnapshotClose, collectCierre } from '../close/autopilot-collect';
import { daysBetween, plural } from '../commitments/shape';
import {
  type ComplianceAutopilotSnapshot,
  collectComplianceDue,
  collectPqrsDeadlines,
} from '../compliance/autopilot';
import { type SnapshotContractNotice, collectContractNotices } from '../contracts/autopilot';
import {
  type SnapshotCrm,
  collectClientesEnRiesgo,
  collectNegociosQuietos,
} from '../crm/autopilot-collect';
import { type SnapshotExpiration, collectDocumentExpirations } from '../doc-expirations/autopilot';
import { type SnapshotFleet, collectFlota } from '../fleet/autopilot-collect';
import { type SnapshotReorder, collectReposicion } from '../inventory/autopilot-collect';
import type { ModuleKey } from '../modules/catalog';
import { overdueStage } from '../payments/risk';
import { type SnapshotPayroll, collectNomina } from '../payroll/autopilot';
import { type SnapshotProjects, collectProyectos } from '../projects/autopilot-collect';
import { type SnapshotSst, collectSst } from '../sst/autopilot';
import { type SnapshotTaxDraft, collectBorradores } from '../tax/autopilot-drafts';
import { type AnomalySource, collectAnomalias } from './anomalies';
import type { AutopilotArea, PlanItem } from './types';

/**
 * LOS RECOLECTORES: DE LO QUE HAY EN LOS DATOS A «COSAS DEL DÍA».
 *
 * Cada uno es una función pura que recibe una parte de la fotografía de la
 * mañana (`AutopilotSnapshot`, armada en sources.ts con una lectura aislada por
 * fuente) y devuelve `PlanItem`s. Ninguno decide si algo se hace: eso es de
 * policy.ts. Lo único que hacen es decir QUÉ vieron, con sus cifras, y QUÉ se
 * podría hacer al respecto.
 *
 * Un recolector que falla no tumba a los demás: `collectAll` envuelve cada uno.
 * Una fuente que no se pudo leer llega como `undefined` y no produce nada; el
 * plan la nombra en `sourceErrors` (no se interpreta «no pude leer» como «no
 * hay nada»).
 */

// ---------------------------------------------------------------------------
// La fotografía de la mañana
// ---------------------------------------------------------------------------

export interface SnapshotInvoice {
  id: string;
  source?: 'document' | 'accounting';
  docNumber: string | null;
  clientId: string | null;
  counterparty: string | null;
  currency: string;
  balance: number;
  dueOn: string;
  daysOverdue: number;
  /** El contacto de cobro del cliente (el principal, activo, con correo). */
  contact: { name: string | null; email: string } | null;
}

export interface SnapshotRecon {
  paymentId: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  client: string | null;
  /** «Muy probable: …» — el emparejador lo dio por seguro (ver bank/store.ts). */
  reason: string;
  suggestions: Array<{
    kind: 'document' | 'accounting';
    id: string;
    docNumber: string | null;
    clientName: string | null;
    exact: boolean;
    reasons: string[];
  }>;
}

export interface SnapshotSync {
  kind: 'drive_folder' | 'table_sync' | 'accounting';
  id: string;
  /** Lo que la persona reconoce: la carpeta, la tabla, el programa. */
  name: string;
  /** Para `accounting`: siigo | alegra | quickbooks. */
  provider?: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface SnapshotCommitment {
  id: string;
  title: string;
  kind: string;
  counterparty: string | null;
  amountCop: number | null;
  dueOn: string;
  ownerUserId: string | null;
  ownerName: string | null;
}

/** Una obligación tributaria pendiente (calendario tributario, 0180). */
export interface SnapshotTaxObligation {
  id: string;
  title: string;
  authority: string;
  dueOn: string;
  /** El vencimiento que la vigila: la misma cosa que ve `collectVencimientos`. */
  commitmentId: string | null;
  needsConfirmation: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
}

export interface SnapshotSignal {
  kind: string;
  personId?: string | null;
  workType?: string | null;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  evidence: Record<string, number | string>;
  suggestion?: string | null;
  itemIds?: string[] | null;
}

export interface SnapshotApproval {
  id: string;
  userId: string;
  ownerName: string | null;
  kindLabel: string;
  recipient: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
}

export interface SnapshotSupplierInvoices {
  /** Ids de las que esperan aprobación, la que vence primero adelante (hasta 25). */
  ids: string[];
  count: number;
  /** Neto de retenciones, en `currency`. */
  amount: number;
  currency: string;
  firstDue: string | null;
  firstLabel: string | null;
  /** Cuántas traen un aviso de la revisión (posible doble cobro, NIT, precio…). */
  flagged: number;
}

export interface SnapshotCashAlert {
  kind: string;
  week?: string | null;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}

export interface AutopilotSnapshot {
  today: string;
  overdueInvoices?: SnapshotInvoice[];
  payments?: {
    overdueAmount: number;
    dueSoonAmount: number;
    commitments: number;
    finesPending: number;
  };
  reconciliation?: SnapshotRecon[];
  uncategorized?: { count: number; amount: number; currency: string };
  syncs?: SnapshotSync[];
  commitments?: SnapshotCommitment[];
  taxObligations?: SnapshotTaxObligation[];
  /** Declaraciones con borrador que vencen en una semana (0197). */
  taxDrafts?: SnapshotTaxDraft[];
  /** Documentos que vencen (0184): lo abierto y lo que espera confirmación. */
  documentExpirations?: SnapshotExpiration[];
  signals?: SnapshotSignal[];
  staleApprovals?: SnapshotApproval[];
  /** Facturas de proveedor esperando aprobación (0181, cuentas por pagar). */
  supplierInvoices?: SnapshotSupplierInvoices;
  /** Lo que hay que reponer del inventario (0183). */
  reorder?: SnapshotReorder;
  /** Gastos que se salieron del presupuesto (0191). */
  budget?: SnapshotBudget;
  /** El cierre del mes anterior, del día 1 al 5 (0192). */
  close?: SnapshotClose;
  /** Negocios quietos y clientes que subieron de riesgo (0193, embudo comercial). */
  crm?: SnapshotCrm;
  /** Proyectos sobre el presupuesto y terminados sin facturar (0196). */
  projects?: SnapshotProjects;
  /** Mantenimiento que toca y consumo de combustible raro (0196). */
  fleet?: SnapshotFleet;
  cash?: {
    currency: string;
    alerts: SnapshotCashAlert[];
    lowestWeek: string | null;
    lowestClosing: number | null;
  };
  /** La nómina del periodo y las ausencias por aprobar (0194). */
  payroll?: SnapshotPayroll;
  /** Plazos de accidentes y actividades del SG-SST (0194). */
  sst?: SnapshotSst;
  /** Contratos en su ventana de aviso previo o por terminar (0195). */
  contractNotices?: SnapshotContractNotice[];
  /** PQRS por vencer y obligaciones de la lista de cumplimiento (0195). */
  compliance?: ComplianceAutopilotSnapshot;
  /** Fuentes que suelen traer filas, con las horas de sus filas (anomalías). */
  anomalySources?: AnomalySource[];
  /** Módulos que la empresa apagó (0186): sus recolectores no corren. */
  modulesOff?: ModuleKey[];
}

// ---------------------------------------------------------------------------
// Ayudas de texto
// ---------------------------------------------------------------------------

export function money(amount: number, currency = 'COP'): string {
  const c = (currency || 'COP').toUpperCase();
  if (c === 'COP') return `$ ${Math.round(amount).toLocaleString('es-CO')}`;
  return `${amount.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${c}`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Cuántas cosas de cada clase entran como máximo al plan de un día. */
export const PER_AREA_CAP: Record<AutopilotArea, number> = {
  cobro: 10,
  pagos: 1,
  conciliacion: 15,
  equipo: 6,
  procesos: 8,
  vencimientos: 15,
  gerencia: 10,
  finanzas: 4,
};

// ---------------------------------------------------------------------------
// Cobro
// ---------------------------------------------------------------------------

/**
 * El correo de cobro de una factura. Para el cliente, de *usted*, corto: dice
 * el hecho, pide una fecha y ofrece revisar la factura si algo está mal — la
 * mitad de los «no han pagado» resulta ser «la factura llegó mal».
 */
export function draftInvoiceCollection(
  inv: SnapshotInvoice,
  _today: string,
): { subject: string; body: string } {
  const doc = inv.docNumber ? `la factura ${inv.docNumber}` : 'la factura pendiente';
  const amount = money(inv.balance, inv.currency);
  const greeting = inv.contact?.name?.trim()
    ? `Buen día, ${inv.contact.name.trim().split(/\s+/)[0]}:`
    : 'Buen día:';
  return {
    subject: `Saldo pendiente — ${inv.docNumber ? `factura ${inv.docNumber}` : 'factura'} por ${amount}`,
    body: [
      greeting,
      '',
      `Nos permitimos recordarle que ${doc}, con saldo de ${amount}, venció el ${longDate(inv.dueOn)} y a la fecha lleva ${plural(inv.daysOverdue, 'día')} de mora.`,
      '',
      'Le agradecemos confirmarnos la fecha en que quedaría realizado el pago. Si hay alguna novedad con la factura, cuéntenos y la revisamos de inmediato.',
      '',
      'Quedamos atentos.',
    ].join('\n'),
  };
}

export function collectCobro(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  const invoices = [...(s.overdueInvoices ?? [])]
    .filter((i) => i.balance > 0 && i.daysOverdue > 0)
    .sort((a, b) => b.balance - a.balance);
  for (const inv of invoices.slice(0, PER_AREA_CAP.cobro)) {
    const stage = overdueStage(inv.daysOverdue);
    if (!stage) continue;
    const who = inv.counterparty?.trim() || 'Un cliente';
    const doc = inv.docNumber ? `la factura ${inv.docNumber}` : 'una factura';
    const why = `${who} lleva ${plural(inv.daysOverdue, 'día')} de mora en ${doc} (${money(inv.balance, inv.currency)}); venció el ${longDate(inv.dueOn)}.`;
    const base = {
      area: 'cobro' as const,
      risk: 'medium' as const,
      amount: inv.balance,
      currency: inv.currency,
      counterparty: inv.counterparty,
      dedupeKey: `cobro:${inv.source ?? 'document'}:${inv.id}:${stage}`,
      href: inv.clientId ? `/clients/${inv.clientId}` : '/payments',
    };
    if (!inv.contact) {
      out.push({
        ...base,
        title: `Cobrar a ${who}: falta el correo del contacto`,
        why: `${why} No tengo el correo de nadie de ${who} para cobrarle: agrégalo en Clientes y mañana preparo el cobro.`,
        proposedAction: null,
        effect: null,
      });
      continue;
    }
    const draft = draftInvoiceCollection(inv, s.today);
    out.push({
      ...base,
      title: `Cobrar ${money(inv.balance, inv.currency)} a ${who}`,
      why,
      proposedAction: {
        toolId: 'gmail.send_message',
        input: { to: [inv.contact.email], subject: draft.subject, body: draft.body },
      },
      effect: 'external_message',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pagos: sólo se cuentan. Nunca se mueve plata.
// ---------------------------------------------------------------------------

export function collectPagos(s: AutopilotSnapshot): PlanItem[] {
  const p = s.payments;
  if (!p) return [];
  const parts: string[] = [];
  if (p.overdueAmount > 0) parts.push(`${money(p.overdueAmount)} en pagos ya vencidos`);
  if (p.dueSoonAmount > 0) parts.push(`${money(p.dueSoonAmount)} por pagar esta semana`);
  if (p.finesPending > 0) parts.push(`${money(p.finesPending)} en multas pendientes`);
  if (parts.length === 0) return [];
  return [
    {
      area: 'pagos',
      title: 'Pagos de la semana',
      why: `Hay ${parts.join(', ')}${p.commitments > 0 ? ` (${plural(p.commitments, 'compromiso')} de pago)` : ''}. Los pagos los haces tú: yo no muevo plata.`,
      proposedAction: null,
      effect: null,
      risk: p.overdueAmount > 0 ? 'high' : 'medium',
      amount: p.overdueAmount + p.dueSoonAmount,
      currency: 'COP',
      dedupeKey: `pagos:semana:${s.today}`,
      href: '/payments',
    },
  ];
}

/**
 * Facturas de proveedor por aprobar (0181): UNA pregunta con todas, para
 * aprobarlas de una vez. Aprobar no paga: después se programa el día contra la
 * caja (/pagar). Siempre pregunta: aprobar una deuda es de una persona.
 */
export function collectProveedores(s: AutopilotSnapshot): PlanItem[] {
  const p = s.supplierInvoices;
  if (!p || p.count === 0 || p.ids.length === 0) return [];
  const first = p.firstDue
    ? `, vence la primera el ${shortDate(p.firstDue)}${p.firstLabel ? ` (${p.firstLabel})` : ''}`
    : '';
  return [
    {
      area: 'pagos',
      title: `${plural(p.count, 'factura de proveedor', 'facturas de proveedor')} por aprobar (${money(p.amount, p.currency)})${first}`,
      why: `${p.flagged > 0 ? `${p.flagged === 1 ? 'Una trae' : `${p.flagged} traen`} un aviso de la revisión (míralo en Por pagar antes de aprobar). ` : ''}Aprobar no paga nada: después programo el día de pago contra la caja, y el pago lo haces tú en el banco.`,
      proposedAction: { toolId: 'payables.approve', input: { invoices: p.ids } },
      effect: 'money',
      risk: p.flagged > 0 ? 'high' : 'medium',
      amount: p.amount,
      currency: p.currency,
      counterparty: p.firstLabel,
      dedupeKey: `pagos:proveedores:${[...p.ids]
        .sort()
        .map((id) => id.slice(0, 8))
        .join(',')}`.slice(0, 300),
      href: '/pagar',
    },
  ];
}

// ---------------------------------------------------------------------------
// Conciliación del banco
// ---------------------------------------------------------------------------

/** ¿El emparejador lo dio por seguro? (status `matched`, ver payments/bank/store.ts). */
export function isUnambiguous(r: SnapshotRecon): boolean {
  const best = r.suggestions[0];
  return r.reason.startsWith('Muy probable') && !!best && best.exact;
}

export function collectConciliacion(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  const recon = s.reconciliation ?? [];
  const sure = recon.filter(isUnambiguous);
  // Dos pagos que «casan sin duda» con la MISMA factura no casan sin duda.
  const byInvoice = new Map<string, number>();
  for (const r of sure) {
    const key = `${r.suggestions[0]?.kind}:${r.suggestions[0]?.id}`;
    byInvoice.set(key, (byInvoice.get(key) ?? 0) + 1);
  }
  for (const r of sure.slice(0, PER_AREA_CAP.conciliacion)) {
    const best = r.suggestions[0];
    if (!best) continue;
    const contested = (byInvoice.get(`${best.kind}:${best.id}`) ?? 0) > 1;
    const who = best.clientName ?? r.client ?? 'el cliente';
    const doc = best.docNumber ? `la factura ${best.docNumber}` : 'una factura abierta';
    out.push({
      area: 'conciliacion',
      title: `Atar ${money(r.amount, r.currency)} de ${who} a ${doc}`,
      why: contested
        ? `Entraron ${money(r.amount, r.currency)} al banco el ${shortDate(r.date)}, pero hay otro pago que también casa con ${doc}: hay que elegir.`
        : `Entraron ${money(r.amount, r.currency)} al banco el ${shortDate(r.date)} («${clip(r.description, 60)}») y casan sin duda con ${doc} de ${who}: ${best.reasons.join(' y ') || 'mismo valor'}.`,
      proposedAction: {
        toolId: 'payments.apply_to_invoice',
        input: { paymentId: r.paymentId, invoiceKind: best.kind, invoiceId: best.id },
      },
      effect: 'internal_write',
      risk: contested ? 'medium' : 'low',
      amount: r.amount,
      currency: r.currency,
      counterparty: who,
      dedupeKey: `conciliar:${r.paymentId}`,
      href: '/payments#extractos',
      undo: { href: '/payments#extractos', label: 'Revisar en Pagos' },
    });
  }
  const doubtful = recon.length - sure.length;
  if (doubtful > 0)
    out.push({
      area: 'conciliacion',
      title: `${plural(doubtful, 'pago')} del banco con factura por confirmar`,
      why: `${plural(doubtful, 'pago')} que ${doubtful === 1 ? 'entró' : 'entraron'} al banco ${doubtful === 1 ? 'tiene' : 'tienen'} una factura sugerida, pero no sin duda: hay que mirarlos.`,
      proposedAction: null,
      effect: null,
      risk: 'low',
      dedupeKey: `conciliar:revisar:${s.today}`,
      href: '/payments#extractos',
    });
  return out;
}

// ---------------------------------------------------------------------------
// Caja y libro de plata
// ---------------------------------------------------------------------------

export function collectFinanzas(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  const u = s.uncategorized;
  if (u && u.count > 0)
    out.push({
      area: 'finanzas',
      title: `Categorizar ${plural(u.count, 'movimiento')} del libro`,
      why: `${plural(u.count, 'movimiento')} del libro de plata no ${u.count === 1 ? 'tiene' : 'tienen'} categoría (${money(u.amount, u.currency)} en total). Uso tus reglas, lo que ya decidiste para la misma contraparte y, si hace falta, el modelo; nunca cambio una categoría que ya tenga.`,
      proposedAction: { toolId: 'ledger.categorize_pending', input: {} },
      effect: 'internal_write',
      risk: 'low',
      dedupeKey: `libro:categorizar:${s.today}`,
      href: '/finance',
      undo: { href: '/finance', label: 'Corregir una categoría' },
    });
  const cash = s.cash;
  for (const a of (cash?.alerts ?? []).filter(
    (x) => x.kind === 'negative_cash' || x.kind === 'low_cash',
  )) {
    out.push({
      area: 'finanzas',
      title: a.kind === 'negative_cash' ? 'La caja se queda en rojo' : 'La caja queda apretada',
      why:
        cash?.lowestWeek && cash.lowestClosing !== null
          ? `${a.message} La semana más apretada es la del ${shortDate(cash.lowestWeek)}, con ${money(cash.lowestClosing, cash.currency)}.`
          : a.message,
      proposedAction: null,
      effect: null,
      risk: a.kind === 'negative_cash' ? 'high' : 'medium',
      dedupeKey: `caja:${a.kind}:${a.week ?? s.today}`,
      href: '/finance',
    });
    if (out.length >= PER_AREA_CAP.finanzas) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procesos que dejaron de sincronizar
// ---------------------------------------------------------------------------

const SYNC_NOUN: Record<SnapshotSync['kind'], string> = {
  drive_folder: 'la carpeta',
  table_sync: 'la sincronización de',
  accounting: 'la conexión con',
};

export function collectProcesos(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  for (const sync of (s.syncs ?? []).slice(0, PER_AREA_CAP.procesos)) {
    const when = sync.lastRunAt ? ` el ${shortDate(sync.lastRunAt.slice(0, 10))}` : '';
    const error = sync.lastError ? `: «${clip(sync.lastError, 140)}»` : '.';
    const action =
      sync.kind === 'accounting'
        ? { toolId: 'accounting.sync_now', input: sync.provider ? { provider: sync.provider } : {} }
        : { toolId: 'trackers.retry_sync', input: { kind: sync.kind, syncId: sync.id } };
    out.push({
      area: 'procesos',
      title: `Reintentar ${SYNC_NOUN[sync.kind]} «${clip(sync.name, 60)}»`,
      why: `La última vuelta de ${SYNC_NOUN[sync.kind]} «${clip(sync.name, 60)}» falló${when}${error}`,
      proposedAction: action,
      effect: 'internal_write',
      risk: 'low',
      dedupeKey: `proceso:${sync.kind}:${sync.id}:${sync.lastRunAt ?? 'nunca'}`,
      href: sync.kind === 'accounting' ? '/integrations' : '/procesos',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vencimientos
// ---------------------------------------------------------------------------

/** Días hacia adelante que cuentan como «por vencer» para el recordatorio. */
export const REMIND_WITHIN_DAYS = 2;

/**
 * Lo que vence en los próximos dos días: un recordatorio a su responsable.
 *
 * Lo YA vencido no se le recuerda aquí, a propósito: el resumen diario de
 * vencidos por persona (follow-through, 0177) ya se lo dice, uno al día y con
 * todo junto. Repetirlo cosa por cosa sería el ruido que enseña a no abrir la
 * campana. Al dueño sí se le cuenta, en una línea.
 */
export function collectVencimientos(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  const rows = (s.commitments ?? [])
    .map((c) => ({ c, left: daysBetween(s.today, c.dueOn) }))
    .filter(({ left }) => Number.isFinite(left) && left <= REMIND_WITHIN_DAYS)
    .sort((a, b) => a.left - b.left);
  const overdue = rows.filter((r) => r.left < 0);
  const soon = rows.filter((r) => r.left >= 0);
  for (const { c, left } of soon.slice(0, PER_AREA_CAP.vencimientos)) {
    const when = left === 0 ? 'vence hoy' : `vence en ${plural(left, 'día')}`;
    const amount = c.amountCop ? ` (${money(c.amountCop)})` : '';
    const why = `«${clip(c.title, 90)}»${c.counterparty ? ` de ${c.counterparty}` : ''}${amount} ${when} (${longDate(c.dueOn)}).`;
    const dedupeKey = `vence:${c.id}:${c.dueOn}`;
    if (!c.ownerUserId) {
      out.push({
        area: 'vencimientos',
        title: `«${clip(c.title, 60)}» no tiene responsable`,
        why: `${why} Nadie lo tiene a su nombre: asígnalo en Vencimientos.`,
        proposedAction: null,
        effect: null,
        risk: 'medium',
        dedupeKey,
        href: '/commitments',
      });
      continue;
    }
    out.push({
      area: 'vencimientos',
      title: `Recordarle a ${c.ownerName ?? 'su responsable'}: «${clip(c.title, 60)}» ${when}`,
      why,
      proposedAction: {
        toolId: 'autopilot.remind',
        input: {
          person: c.ownerUserId,
          title: clip(`«${c.title}» ${when}`, 160),
          body: clip(
            `${why} Si ya está resuelto, márcalo como cumplido en Vencimientos y dejo de recordártelo.`,
            600,
          ),
          href: '/commitments',
          key: dedupeKey,
        },
      },
      effect: 'internal_notice',
      risk: 'low',
      counterparty: c.counterparty,
      dedupeKey,
      href: '/commitments',
    });
  }
  if (overdue.length > 0) {
    const oldest = overdue[0];
    out.push({
      area: 'vencimientos',
      title: `${plural(overdue.length, 'compromiso vencido', 'compromisos vencidos')}`,
      why: `Hay ${plural(overdue.length, 'compromiso vencido', 'compromisos vencidos')}${oldest ? `; el más viejo es «${clip(oldest.c.title, 70)}», vencido hace ${plural(-oldest.left, 'día')}` : ''}. A cada responsable le llega su resumen diario de vencidos.`,
      proposedAction: null,
      effect: null,
      risk: 'medium',
      dedupeKey: `vence:vencidos:${s.today}`,
      href: '/commitments',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Impuestos: lo que vence con la DIAN, el ICA, la PILA…
// ---------------------------------------------------------------------------

/**
 * Días hacia adelante para un impuesto. Más que los dos de un vencimiento
 * cualquiera: una declaración pide sacar cifras, revisar con el contador y
 * tener la plata, y enterarse dos días antes es enterarse tarde.
 */
export const TAX_REMIND_WITHIN_DAYS = 5;

/**
 * «Vence la retención de septiembre en 3 días»: un recordatorio al
 * responsable de los impuestos o, si no hay, un aviso al dueño.
 *
 * Usa la MISMA clave que `collectVencimientos` cuando la obligación tiene su
 * vencimiento (`vence:<compromiso>:<fecha>`), y corre antes que él: la cosa
 * es una sola, y gana la frase que dice qué impuesto es y si la fecha está
 * por confirmar. Nunca presenta ni paga nada.
 */
export function collectImpuestos(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  const rows = (s.taxObligations ?? [])
    .map((o) => ({ o, left: daysBetween(s.today, o.dueOn) }))
    .filter(({ left }) => Number.isFinite(left) && left >= 0 && left <= TAX_REMIND_WITHIN_DAYS)
    .sort((a, b) => a.left - b.left);
  for (const { o, left } of rows.slice(0, PER_AREA_CAP.vencimientos)) {
    const when = left === 0 ? 'vence hoy' : `vence en ${plural(left, 'día')}`;
    const doubt = o.needsConfirmation ? ' La fecha está por confirmar con el contador.' : '';
    const why = `«${clip(o.title, 90)}» (${o.authority}) ${when}, el ${longDate(o.dueOn)}.${doubt}`;
    const dedupeKey = o.commitmentId
      ? `vence:${o.commitmentId}:${o.dueOn}`
      : `impuesto:${o.id}:${o.dueOn}`;
    if (!o.ownerUserId) {
      out.push({
        area: 'vencimientos',
        title: `${clip(o.title, 70)} ${when}`,
        why: `${why} Nadie responde por los impuestos: elige al contador en Impuestos.`,
        proposedAction: null,
        effect: null,
        risk: 'medium',
        counterparty: o.authority,
        dedupeKey,
        href: '/impuestos',
      });
      continue;
    }
    out.push({
      area: 'vencimientos',
      title: `Recordarle a ${o.ownerName ?? 'quien lleva los impuestos'}: ${clip(o.title, 60)} ${when}`,
      why,
      proposedAction: {
        toolId: 'autopilot.remind',
        input: {
          person: o.ownerUserId,
          title: clip(`${o.title} ${when}`, 160),
          body: clip(
            `${why} Cuando quede presentada o pagada, márcala en Impuestos con el comprobante y dejo de recordártelo.`,
            600,
          ),
          href: '/impuestos',
          key: dedupeKey,
        },
      },
      effect: 'internal_notice',
      risk: 'low',
      counterparty: o.authority,
      dedupeKey,
      href: '/impuestos',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Equipo: gente sobrecargada
// ---------------------------------------------------------------------------

export function collectEquipo(s: AutopilotSnapshot): PlanItem[] {
  const out: PlanItem[] = [];
  for (const sig of (s.signals ?? []).filter((x) => x.kind === 'overloaded')) {
    const e = sig.evidence;
    const person = String(e.person ?? 'Alguien');
    const workType = String(e.workType ?? sig.workType ?? 'trabajo');
    const ids = [...(sig.itemIds ?? [])];
    let offset = 0;
    let planned = 0;
    for (let n = 1; n <= 3; n++) {
      const receiver = e[`receiver${n}`];
      const take = Number(e[`receiver${n}Take`] ?? 0);
      if (typeof receiver !== 'string' || !Number.isFinite(take) || take <= 0) break;
      const itemIds = ids.slice(offset, offset + take);
      offset += take;
      if (!itemIds.length) break;
      planned += 1;
      out.push({
        area: 'equipo',
        title: `Pasarle ${plural(itemIds.length, workType === 'trabajo' ? 'tarea' : workType)} de ${person} a ${receiver}`,
        why: `${sig.message} ${sig.suggestion ?? ''}`.trim(),
        proposedAction: { toolId: 'work.assign', input: { itemIds, person: receiver } },
        effect: 'internal_write',
        risk: 'medium',
        counterparty: person,
        dedupeKey: `equipo:${sig.personId ?? person}:${workType}:${receiver}:${[...itemIds].sort().join(',').slice(0, 120)}`,
        href: sig.personId ? `/team/${sig.personId}` : '/team',
      });
    }
    if (planned === 0)
      out.push({
        area: 'equipo',
        title: `${person} está sobrecargado en ${workType}`,
        why: `${sig.message} ${sig.suggestion ?? ''}`.trim(),
        proposedAction: null,
        effect: null,
        risk: sig.severity === 'critical' ? 'high' : 'medium',
        dedupeKey: `equipo:${sig.personId ?? person}:${workType}:${s.today}`,
        href: sig.personId ? `/team/${sig.personId}` : '/team',
      });
    if (out.length >= PER_AREA_CAP.equipo) break;
  }
  return out.slice(0, PER_AREA_CAP.equipo);
}

// ---------------------------------------------------------------------------
// Gerencia: aprobaciones paradas
// ---------------------------------------------------------------------------

/** Horas paradas antes de contarlas. Las mismas 48 del escalado (actions/escalation.ts). */
export const STALE_APPROVAL_HOURS = 48;

/**
 * Las aprobaciones paradas se le CUENTAN al dueño, en una línea. El
 * recordatorio a cada responsable ya existe y es uno por persona y día
 * (follow-through/aging.ts, 0177), más el aviso al jefe a las 48 h
 * (actions/escalation.ts). Un tercer recordatorio por borrador sería ruido.
 */
export function collectGerencia(s: AutopilotSnapshot, now: Date): PlanItem[] {
  const cutoff = now.getTime() - STALE_APPROVAL_HOURS * 3_600_000;
  const stale = (s.staleApprovals ?? [])
    .filter((a) => Date.parse(a.createdAt) <= cutoff && Date.parse(a.expiresAt) > now.getTime())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (stale.length === 0) return [];
  const oldest = stale[0] as SnapshotApproval;
  const days = Math.max(2, Math.floor((now.getTime() - Date.parse(oldest.createdAt)) / 86_400_000));
  const people = new Set(stale.map((a) => a.ownerName ?? a.userId)).size;
  return [
    {
      area: 'gerencia',
      title: `${plural(stale.length, 'aprobación parada', 'aprobaciones paradas')}`,
      why: `${plural(stale.length, 'propuesta lleva', 'propuestas llevan')} más de ${STALE_APPROVAL_HOURS} horas esperando decisión de ${plural(people, 'persona', 'personas')}; la más vieja (${oldest.kindLabel} a ${clip(oldest.recipient, 50)}) lleva ${plural(days, 'día')} y deja de poderse aprobar el ${shortDate(oldest.expiresAt.slice(0, 10))}. A cada responsable ya le llega su recordatorio.`,
      proposedAction: null,
      effect: null,
      risk: 'medium',
      dedupeKey: `aprobaciones:paradas:${s.today}`,
      href: '/approvals',
    },
  ];
}

// ---------------------------------------------------------------------------
// Todos, aislados
// ---------------------------------------------------------------------------

export const COLLECTORS: Array<{
  area: AutopilotArea;
  run: (s: AutopilotSnapshot, now: Date) => PlanItem[];
  /** El módulo del que es (0186). Apagado ese módulo, el recolector no corre. */
  module?: ModuleKey;
}> = [
  { area: 'cobro', run: collectCobro },
  { area: 'pagos', run: collectPagos },
  { area: 'pagos', run: collectProveedores, module: 'payables' },
  // 0183: lo que está bajo el mínimo → órdenes de compra para aprobar.
  { area: 'pagos', run: (s) => collectReposicion(s.reorder, s.today), module: 'inventory' },
  { area: 'conciliacion', run: collectConciliacion },
  { area: 'finanzas', run: collectFinanzas, module: 'finance' },
  // 0191: lo que se salió del presupuesto (sólo aviso).
  { area: 'finanzas', run: (s) => collectPresupuesto(s.budget), module: 'budget' },
  // 0192: «Cierre de septiembre: faltan 4 cosas» (sólo aviso, días 1–5).
  { area: 'finanzas', run: (s) => collectCierre(s.close, s.today), module: 'accounting_close' },
  { area: 'procesos', run: collectProcesos },
  // Lo que no falla pero se quedó mudo: sin filas nuevas, o un día muy flojo.
  { area: 'procesos', run: (s, now) => collectAnomalias(s.anomalySources, now) },
  // Antes que los vencimientos: comparten clave y gana la frase del impuesto.
  { area: 'vencimientos', run: collectImpuestos, module: 'taxes' },
  // 0197: «Borrador de IVA listo para revisión del contador» (sólo aviso, 7 días antes).
  { area: 'vencimientos', run: (s) => collectBorradores(s.taxDrafts, s.today), module: 'taxes' },
  { area: 'vencimientos', run: collectVencimientos },
  {
    area: 'vencimientos',
    run: (s) => collectDocumentExpirations(s.documentExpirations, s.today),
    module: 'doc_expirations',
  },
  // 0195: PQRS por vencer (pregunta: el plazo es legal), avisos previos de
  // contratos y lo que vence de la lista de cumplimiento (sólo aviso).
  { area: 'vencimientos', run: (s) => collectPqrsDeadlines(s.compliance), module: 'compliance' },
  {
    area: 'vencimientos',
    run: (s) => collectContractNotices(s.contractNotices, s.today),
    module: 'contracts',
  },
  {
    area: 'vencimientos',
    run: (s) => collectComplianceDue(s.compliance, s.today),
    module: 'compliance',
  },
  { area: 'equipo', run: collectEquipo, module: 'team' },
  // 0194: la nómina que vence (aviso) y las ausencias por aprobar (pregunta).
  { area: 'pagos', run: (s) => collectNomina(s.payroll, s.today), module: 'payroll' },
  // 0194: plazos de FURAT e investigación, actividades sin registrar (aviso).
  { area: 'vencimientos', run: (s) => collectSst(s.sst, s.today), module: 'sst' },
  { area: 'gerencia', run: collectGerencia },
  // 0193: negocios quietos → tarea de seguimiento (pregunta); clientes que
  // subieron de riesgo de perderse (sólo aviso, sólo lo nuevo).
  { area: 'gerencia', run: (s) => collectNegociosQuietos(s.crm, s.today), module: 'crm' },
  { area: 'gerencia', run: (s) => collectClientesEnRiesgo(s.crm), module: 'crm' },
  // 0196: proyectos pasados del presupuesto (aviso) y terminados sin facturar
  // (pregunta: deja la factura en borrador); mantenimiento y combustible (aviso).
  { area: 'gerencia', run: (s) => collectProyectos(s.projects, s.today), module: 'service_orders' },
  { area: 'vencimientos', run: (s) => collectFlota(s.fleet, s.today), module: 'fleet' },
];

/**
 * Todos los recolectores, cada uno en su propio try: si uno revienta, su área
 * queda vacía y el error se nombra; los demás siguen. Las claves repetidas se
 * quedan con la primera aparición.
 */
export function collectAll(
  s: AutopilotSnapshot,
  now: Date,
): { items: PlanItem[]; errors: Array<{ source: string; message: string }> } {
  const items: PlanItem[] = [];
  const errors: Array<{ source: string; message: string }> = [];
  const seen = new Set<string>();
  const off = new Set(s.modulesOff ?? []);
  for (const c of COLLECTORS) {
    if (c.module && off.has(c.module)) continue;
    try {
      for (const item of c.run(s, now)) {
        if (seen.has(item.dedupeKey)) continue;
        seen.add(item.dedupeKey);
        items.push(item);
      }
    } catch (err) {
      errors.push({
        source: c.area,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { items, errors };
}
