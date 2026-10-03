import type {
  TaxObligationView,
  TaxPerson,
  TaxProfileView,
  TaxScreenData,
  TaxSummary,
} from '@/components/tax/types';
import type { StatusTone } from '@/lib/status-chip';
import {
  OBLIGATION_KIND_LABEL,
  OBLIGATION_STATUS_LABEL,
  type TaxObligation,
  type TaxProfile,
  daysBetween,
  isFulfilled,
  plural,
} from '@cortex/agent-tools';

/**
 * DE LAS FILAS A LA PANTALLA DE IMPUESTOS. Puro: recibe lo leído y devuelve lo
 * que dibujan los componentes de cliente (components/tax). La ficha de muestra
 * (/v/impuestos-showcase) lo usa igual, con el motor de verdad.
 */

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

function weekday(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? '';
}

/**
 * El tono dice qué tan urgente es, no qué es:
 *   rose     vencida sin marcar
 *   amber    vence en los próximos 7 días, o presentada sin pagar lo que se paga
 *   primary  pendiente más adelante
 *   emerald  cumplida
 *   neutral  no aplica
 */
export function obligationTone(
  o: Pick<TaxObligation, 'status' | 'requiresPayment'>,
  daysLeft: number,
): StatusTone {
  if (o.status === 'no_aplica') return 'neutral';
  if (isFulfilled(o.status, o.requiresPayment)) return 'emerald';
  if (daysLeft < 0) return 'rose';
  if (daysLeft <= 7 || o.status === 'presentada') return 'amber';
  return 'primary';
}

function whenText(o: TaxObligation, daysLeft: number): string {
  if (o.status !== 'pendiente' && o.statusAt) {
    const label = OBLIGATION_STATUS_LABEL[o.status];
    return `${label} el ${shortDay(o.statusAt.slice(0, 10))}`;
  }
  if (daysLeft < 0) return `Venció hace ${plural(-daysLeft, 'día')}`;
  if (daysLeft === 0) return 'Vence hoy';
  if (daysLeft === 1) return 'Vence mañana';
  return `Vence en ${plural(daysLeft, 'día')}`;
}

export function adaptObligation(
  o: TaxObligation,
  today: string,
  opts: { documentTitles?: Map<string, string>; href?: (path: string) => string } = {},
): TaxObligationView {
  const daysLeft = daysBetween(today, o.dueDate);
  const href = opts.href ?? ((p: string) => p);
  const evidenceHref = o.evidenceDocumentId
    ? href(`/kb?document=${encodeURIComponent(o.evidenceDocumentId)}`)
    : o.evidenceUrl;
  const evidenceLabel = o.evidenceDocumentId
    ? (opts.documentTitles?.get(o.evidenceDocumentId) ?? 'Documento en el Cerebro')
    : o.evidenceUrl
      ? 'Enlace'
      : null;
  return {
    id: o.id,
    kind: o.kind,
    kindLabel: OBLIGATION_KIND_LABEL[o.kind],
    title: o.title,
    period: o.period,
    authority: o.authority,
    form: o.form,
    dueDate: o.dueDate,
    dueLabel: shortDay(o.dueDate),
    weekday: weekday(o.dueDate),
    month: o.dueDate.slice(0, 7),
    daysLeft,
    status: o.status,
    statusLabel: OBLIGATION_STATUS_LABEL[o.status],
    tone: obligationTone(o, daysLeft),
    whenText: whenText(o, daysLeft),
    overdue: o.status === 'pendiente' && daysLeft < 0,
    needsConfirmation: o.needsConfirmation,
    requiresPayment: o.requiresPayment,
    sourceNote: o.sourceNote,
    statusNote: o.statusNote,
    evidenceHref: evidenceHref ?? null,
    evidenceLabel,
  };
}

export function summarize(rows: TaxObligationView[]): TaxSummary {
  const pending = rows.filter((r) => r.status === 'pendiente');
  return {
    pending: pending.length,
    overdue: pending.filter((r) => r.overdue).length,
    toConfirm: pending.filter((r) => r.needsConfirmation).length,
    done: rows.filter((r) => r.status !== 'pendiente').length,
    next: pending.find((r) => r.daysLeft >= 0) ?? null,
  };
}

export function adaptProfile(p: TaxProfile, people: TaxPerson[]): TaxProfileView {
  return {
    nit: p.nit,
    dv: p.dv,
    personType: p.personType,
    granContribuyente: p.granContribuyente,
    regimenSimple: p.regimenSimple,
    ivaPeriodicity: p.ivaPeriodicity,
    agenteRetencion: p.agenteRetencion,
    icaCity: p.icaCity,
    icaPeriodicity: p.icaPeriodicity,
    exogena: p.exogena,
    activosExterior: p.activosExterior,
    camaraComercio: p.camaraComercio,
    nominaElectronica: p.nominaElectronica,
    pila: p.pila,
    facturacionElectronica: p.facturacionElectronica,
    ownerUserId: p.ownerUserId,
    ownerName: p.ownerUserId ? (people.find((x) => x.id === p.ownerUserId)?.name ?? null) : null,
    noticeDays: p.noticeDays,
    source: p.source,
    updatedLabel: p.updatedAt ? shortDay(p.updatedAt.slice(0, 10)) : null,
  };
}

export function buildTaxScreen(input: {
  year: number;
  years: number[];
  today: string;
  profile: TaxProfile | null;
  obligations: TaxObligation[];
  gaps: string[];
  sourceLine: string;
  canEdit: boolean;
  canMark: boolean;
  people: TaxPerson[];
  suggestedNit: string | null;
  documentTitles?: Map<string, string>;
  href?: (path: string) => string;
}): TaxScreenData {
  const obligations = input.obligations.map((o) =>
    adaptObligation(o, input.today, { documentTitles: input.documentTitles, href: input.href }),
  );
  return {
    year: input.year,
    years: input.years,
    today: input.today,
    profile: input.profile ? adaptProfile(input.profile, input.people) : null,
    obligations,
    summary: summarize(obligations),
    gaps: input.gaps,
    sourceLine: input.sourceLine,
    canEdit: input.canEdit,
    canMark: input.canMark,
    people: input.people,
    suggestedNit: input.suggestedNit,
  };
}

/** El NIT escrito en «Datos de la empresa» (sección Identidad), si lo hay. */
export function nitFromFacts(facts: Array<{ label: string; value: string }>): string | null {
  const hit = facts.find((f) => /^\s*nit\b/i.test(f.label));
  const value = hit?.value.trim();
  return value && /\d{5,}/.test(value.replace(/\D/g, '')) ? value : null;
}

/** La petición al chat para leer el RUT desde el Cerebro. */
export const RUT_PROMPT =
  'Busca el RUT de la empresa en el Cerebro y léelo: dime el NIT con su dígito de verificación, si es persona natural o jurídica, y las responsabilidades que tiene marcadas (gran contribuyente, Régimen Simple, responsable de IVA y su periodicidad, agente de retención, exógena, nómina electrónica, facturación electrónica) con la casilla de donde sale cada una. Luego propónme el perfil tributario con tax.configure (source=rut y el documento) para que lo confirme. Si no encuentras el RUT, dime cómo subirlo.';
