import { addDays, addMonths, daysBetween } from '../commitments/shape';

/**
 * EL VOCABULARIO DE CONTRATOS (migración 0195).
 *
 * Tipos, estados, etiquetas y la cuenta de la vigencia: cuándo termina el
 * período en curso de un contrato que se renueva solo y hasta qué día se puede
 * avisar que no se renueva. Puro: nada de base de datos ni de reloj (el «hoy»
 * llega como argumento).
 *
 * NADA DE AQUÍ ES ASESORÍA LEGAL. Las fechas son las que escribió una persona
 * o las que dice el contrato; esto sólo hace la aritmética.
 */

export const CONTRACT_TYPES = [
  'prestacion_servicios',
  'confidencialidad',
  'laboral_fijo',
  'laboral_indefinido',
  'compraventa',
  'arrendamiento_comercial',
  'otrosi',
  'terminacion',
  'otro',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  prestacion_servicios: 'Prestación de servicios',
  confidencialidad: 'Confidencialidad (NDA)',
  laboral_fijo: 'Laboral a término fijo',
  laboral_indefinido: 'Laboral a término indefinido',
  compraventa: 'Compraventa',
  arrendamiento_comercial: 'Arrendamiento comercial',
  otrosi: 'Otrosí',
  terminacion: 'Carta de terminación',
  otro: 'Otro',
};

export const CONTRACT_STATUSES = [
  'borrador',
  'en_revision',
  'firmado',
  'vigente',
  'vencido',
  'terminado',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  borrador: 'Borrador',
  en_revision: 'En revisión',
  firmado: 'Firmado',
  vigente: 'Vigente',
  vencido: 'Vencido',
  terminado: 'Terminado',
};

export const CONTRACT_STATUS_TONE: Record<
  ContractStatus,
  'neutral' | 'primary' | 'emerald' | 'amber' | 'rose'
> = {
  borrador: 'neutral',
  en_revision: 'amber',
  firmado: 'primary',
  vigente: 'emerald',
  vencido: 'rose',
  terminado: 'neutral',
};

export const COUNTERPARTY_KINDS = ['cliente', 'proveedor', 'empleado', 'otro'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

export const COUNTERPARTY_KIND_LABEL: Record<CounterpartyKind, string> = {
  cliente: 'Cliente',
  proveedor: 'Proveedor',
  empleado: 'Persona del equipo',
  otro: 'Otra persona o empresa',
};

export const RENEWALS = ['ninguna', 'automatica', 'prorroga'] as const;
export type Renewal = (typeof RENEWALS)[number];

export const RENEWAL_LABEL: Record<Renewal, string> = {
  ninguna: 'Termina en su fecha',
  automatica: 'Se renueva sola si nadie avisa',
  prorroga: 'Sólo con prórroga pactada',
};

export const OBLIGATION_PARTIES = ['nosotros', 'contraparte', 'ambas'] as const;
export type ObligationParty = (typeof OBLIGATION_PARTIES)[number];

export const OBLIGATION_PARTY_LABEL: Record<ObligationParty, string> = {
  nosotros: 'Nosotros',
  contraparte: 'La contraparte',
  ambas: 'Ambas partes',
};

export const OBLIGATION_CATEGORIES = [
  'pago',
  'entrega',
  'reporte',
  'renovacion',
  'confidencialidad',
  'garantia',
  'otra',
] as const;
export type ObligationCategory = (typeof OBLIGATION_CATEGORIES)[number];

export const OBLIGATION_CATEGORY_LABEL: Record<ObligationCategory, string> = {
  pago: 'Pago',
  entrega: 'Entrega',
  reporte: 'Informe o reporte',
  renovacion: 'Renovación o aviso',
  confidencialidad: 'Confidencialidad',
  garantia: 'Garantía o póliza',
  otra: 'Otra',
};

export const OBLIGATION_STATUSES = ['propuesta', 'confirmada', 'descartada', 'cumplida'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const OBLIGATION_STATUS_LABEL: Record<ObligationStatus, string> = {
  propuesta: 'Por confirmar',
  confirmada: 'Confirmada',
  descartada: 'Descartada',
  cumplida: 'Cumplida',
};

export const OBLIGATION_RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly'] as const;
export type ObligationRecurrence = (typeof OBLIGATION_RECURRENCES)[number];

export const OBLIGATION_RECURRENCE_LABEL: Record<ObligationRecurrence, string> = {
  none: 'Una vez',
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
  yearly: 'Cada año',
};

export const CONTRACT_EVENT_KINDS = [
  'creado',
  'editado',
  'en_revision',
  'firmado',
  'copia_firmada',
  'obligaciones',
  'aviso',
  'vencimiento',
  'terminado',
  'exportado',
  'nota',
] as const;
export type ContractEventKind = (typeof CONTRACT_EVENT_KINDS)[number];

/** Lo que va arriba de todo borrador, y en cada página del PDF. */
export const DRAFT_NOTICE =
  'BORRADOR PARA REVISIÓN DE UN ABOGADO. Generado con Cortex a partir de una plantilla: no es asesoría legal ni garantiza la validez de lo que dice. Complete los campos marcados [COMPLETAR], revise cada cláusula y ajústela a su caso antes de firmar.';

export const DRAFT_BANNER = 'Borrador para revisión de un abogado';

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export const CONTRACT_COLUMNS =
  'id, contract_type, title, template_key, template_id, counterparty_kind, counterparty_name, counterparty_id_number, client_id, supplier_id, employee_user_id, employee_ref, parent_contract_id, value_amount, currency, value_note, start_on, end_on, renewal, renewal_months, notice_days, status, body_text, placeholders, drafted_with, document_id, signed_at, terminated_on, termination_reason, owner_user_id, expiration_id, notice_commitment_id, created_by, created_at, updated_at';

export interface ContractRow {
  id: string;
  contract_type: ContractType;
  title: string;
  template_key: string | null;
  template_id: string | null;
  counterparty_kind: CounterpartyKind;
  counterparty_name: string | null;
  counterparty_id_number: string | null;
  client_id: string | null;
  supplier_id: string | null;
  employee_user_id: string | null;
  employee_ref: string | null;
  parent_contract_id: string | null;
  value_amount: number | null;
  currency: string;
  value_note: string | null;
  start_on: string | null;
  end_on: string | null;
  renewal: Renewal;
  renewal_months: number | null;
  notice_days: number | null;
  status: ContractStatus;
  body_text: string | null;
  placeholders: string[];
  drafted_with: 'plantilla' | 'chat' | 'subido';
  document_id: string | null;
  signed_at: string | null;
  terminated_on: string | null;
  termination_reason: string | null;
  owner_user_id: string | null;
  expiration_id: string | null;
  notice_commitment_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const OBLIGATION_COLUMNS =
  'id, contract_id, party, responsible_label, category, description, due_on, recurrence, due_note, penalty, evidence_quote, chunk_id, source, status, confidence, review_note, owner_user_id, notice_days, commitment_id, confirmed_by, confirmed_at, created_by, created_at, updated_at';

export interface ObligationRow {
  id: string;
  contract_id: string;
  party: ObligationParty;
  responsible_label: string | null;
  category: ObligationCategory;
  description: string;
  due_on: string | null;
  recurrence: ObligationRecurrence;
  due_note: string | null;
  penalty: string | null;
  evidence_quote: string | null;
  chunk_id: string | null;
  source: 'documento' | 'manual' | 'plantilla';
  status: ObligationStatus;
  confidence: 'alta' | 'media' | 'baja' | null;
  review_note: string | null;
  owner_user_id: string | null;
  notice_days: number | null;
  commitment_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const EVENT_COLUMNS = 'id, contract_id, kind, detail, actor_user_id, created_at';

export interface ContractEventRow {
  id: string;
  contract_id: string;
  kind: ContractEventKind;
  detail: string | null;
  actor_user_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// La vigencia
// ---------------------------------------------------------------------------

/** Lo que se sabe del período en curso de un contrato. */
export interface ContractTerm {
  /** El fin del período en curso (con renovaciones automáticas ya corridas). */
  currentEnd: string | null;
  /** Cuántas veces se renovó solo hasta hoy. */
  renewals: number;
  /** Hasta qué día se puede avisar que no se renueva (o que se termina). */
  noticeDeadline: string | null;
  daysToEnd: number | null;
  daysToNotice: number | null;
}

/** Meses enteros entre dos fechas (redondeado hacia abajo, mínimo 1). */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1 - 1) months -= 1;
  return Math.max(1, months);
}

/**
 * El período en curso. Un contrato que se renueva solo y cuyo fin ya pasó
 * corre su fin hacia adelante, de a `renewal_months` (o lo que duró el primer
 * período), hasta pasar hoy: si nadie avisó a tiempo, sigue vigente. Uno con
 * prórroga pactada o sin renovación termina en su fecha.
 */
export function contractTerm(
  row: Pick<ContractRow, 'start_on' | 'end_on' | 'renewal' | 'renewal_months' | 'notice_days'>,
  today: string,
): ContractTerm {
  if (!row.end_on) {
    return {
      currentEnd: null,
      renewals: 0,
      noticeDeadline: null,
      daysToEnd: null,
      daysToNotice: null,
    };
  }
  let end = row.end_on;
  let renewals = 0;
  if (row.renewal === 'automatica') {
    const step =
      row.renewal_months ??
      (row.start_on ? monthsBetween(row.start_on, addDays(row.end_on, 1)) : 12);
    // Tope: nada aquí mira cien años adelante, y una fecha corrupta no puede
    // colgar una lectura.
    // Siempre desde el fin original: sumar de a un período sobre una fecha ya
    // recortada (31 → 30 de junio) correría el día del mes.
    while (end < today && renewals < 200) {
      renewals += 1;
      end = addMonths(row.end_on, step * renewals);
    }
  }
  const notice = row.notice_days && row.notice_days > 0 ? addDays(end, -row.notice_days) : null;
  return {
    currentEnd: end,
    renewals,
    noticeDeadline: notice,
    daysToEnd: daysBetween(today, end),
    daysToNotice: notice ? daysBetween(today, notice) : null,
  };
}

/**
 * El estado con las fechas de hoy. Borrador, en revisión y terminado son
 * decisiones; firmado / vigente / vencido salen de las fechas.
 */
export function deriveContractStatus(
  row: Pick<
    ContractRow,
    'status' | 'start_on' | 'end_on' | 'renewal' | 'renewal_months' | 'notice_days'
  >,
  today: string,
): ContractStatus {
  if (row.status === 'borrador' || row.status === 'en_revision' || row.status === 'terminado') {
    return row.status;
  }
  if (row.start_on && today < row.start_on) return 'firmado';
  const term = contractTerm(row, today);
  if (!term.currentEnd) return 'vigente';
  return term.currentEnd >= today ? 'vigente' : 'vencido';
}

/**
 * Un contrato laboral (o con alguien del equipo) lleva salario y datos de una
 * persona: lo ven quien administra la empresa, quien lo creó y su responsable.
 */
export function isSensitiveContract(
  row: Pick<ContractRow, 'contract_type' | 'counterparty_kind'>,
): boolean {
  return (
    row.contract_type === 'laboral_fijo' ||
    row.contract_type === 'laboral_indefinido' ||
    row.counterparty_kind === 'empleado'
  );
}

export function canSeeContract(
  row: Pick<ContractRow, 'contract_type' | 'counterparty_kind' | 'created_by' | 'owner_user_id'>,
  viewer: { userId: string; manager: boolean },
): boolean {
  if (!isSensitiveContract(row)) return true;
  return viewer.manager || row.created_by === viewer.userId || row.owner_user_id === viewer.userId;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
