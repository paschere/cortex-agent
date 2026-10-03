import type { CommitmentKind } from '../commitments/shape';
import { daysBetween } from '../commitments/shape';

/**
 * Lo puro de «documentos que vencen»: qué tipos hay, cuánto aviso merece cada
 * uno, en qué estado está un papel hoy y cómo se le dice a una persona.
 *
 * Todo aquí es función de sus argumentos (sin base, sin reloj propio, sin
 * modelo), para que la pantalla, las herramientas, el piloto y las pruebas
 * lean exactamente la misma regla.
 */

export const EXPIRATION_KINDS = [
  'poliza',
  'soat',
  'tecnomecanica',
  'licencia',
  'permiso',
  'contrato',
  'certificado',
  'habilitacion',
  'otro',
] as const;
export type ExpirationKind = (typeof EXPIRATION_KINDS)[number];

export const EXPIRATION_KIND_LABEL: Record<ExpirationKind, string> = {
  poliza: 'Póliza',
  soat: 'SOAT',
  tecnomecanica: 'Tecnomecánica',
  licencia: 'Licencia',
  permiso: 'Permiso',
  contrato: 'Contrato',
  certificado: 'Certificado',
  habilitacion: 'Habilitación',
  otro: 'Otro',
};

/**
 * Cuántos días antes hay que empezar a renovar, por tipo.
 *
 * Es lo que tarda el trámite, no un número redondo: un SOAT se compra en una
 * tarde pero la tecnomecánica pide cita en un CDA; una póliza pide
 * cotizaciones y aprobación; un contrato o una licencia piden una
 * conversación, papeles y a veces una visita.
 */
export const DEFAULT_LEAD_DAYS: Record<ExpirationKind, number> = {
  soat: 30,
  tecnomecanica: 30,
  poliza: 45,
  contrato: 60,
  licencia: 60,
  permiso: 45,
  habilitacion: 60,
  certificado: 30,
  otro: 30,
};

/**
 * El tipo de vencimiento (commitments, 0069) que vigila cada papel. Los que no
 * tienen uno propio van como `other` con su anticipación explícita, para no
 * tocar la lista de tipos que comparten el calendario tributario y la flota.
 */
export const COMMITMENT_KIND_FOR: Record<ExpirationKind, CommitmentKind> = {
  soat: 'soat',
  tecnomecanica: 'rtm',
  poliza: 'policy',
  contrato: 'contract',
  licencia: 'other',
  permiso: 'other',
  certificado: 'other',
  habilitacion: 'other',
  otro: 'other',
};

export const SUBJECT_KINDS = ['vehiculo', 'cliente', 'empleado', 'empresa', 'otro'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_KIND_LABEL: Record<SubjectKind, string> = {
  vehiculo: 'Vehículo',
  cliente: 'Cliente',
  empleado: 'Persona del equipo',
  empresa: 'La empresa',
  otro: 'Otro',
};

/** El sujeto que la flota ya conoce: el SOAT y la tecnomecánica son de un vehículo. */
export function defaultSubjectKind(kind: ExpirationKind): SubjectKind {
  return kind === 'soat' || kind === 'tecnomecanica' ? 'vehiculo' : 'empresa';
}

export const EXPIRATION_STATUSES = [
  'vigente',
  'por_vencer',
  'vencido',
  'renovado',
  'descartado',
] as const;
export type ExpirationStatus = (typeof EXPIRATION_STATUSES)[number];

export const STATUS_LABEL: Record<ExpirationStatus, string> = {
  vigente: 'Vigente',
  por_vencer: 'Por vencer',
  vencido: 'Vencido',
  renovado: 'Renovado',
  descartado: 'Descartado',
};

export const STATUS_TONE: Record<ExpirationStatus, 'emerald' | 'amber' | 'rose' | 'neutral'> = {
  vigente: 'emerald',
  por_vencer: 'amber',
  vencido: 'rose',
  renovado: 'neutral',
  descartado: 'neutral',
};

export type Confidence = 'alta' | 'media' | 'baja';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
};

/**
 * El estado de hoy. `renovado` y `descartado` son decisiones de una persona y
 * se devuelven tal cual; los otros tres salen de la fecha en cada lectura, así
 * la pantalla nunca muestra el estado de ayer.
 */
export function deriveExpirationStatus(
  row: { status?: string | null; expires_on: string | null; renewal_lead_days?: number | null },
  today: string,
): ExpirationStatus {
  if (row.status === 'renovado') return 'renovado';
  if (row.status === 'descartado') return 'descartado';
  if (!row.expires_on) return 'vigente';
  const left = daysBetween(today, row.expires_on);
  if (Number.isNaN(left)) return 'vigente';
  if (left < 0) return 'vencido';
  if (left <= (row.renewal_lead_days ?? DEFAULT_LEAD_DAYS.otro)) return 'por_vencer';
  return 'vigente';
}

/** Lo que todavía es problema de alguien. */
export function isOpenStatus(status: ExpirationStatus): boolean {
  return status === 'vigente' || status === 'por_vencer' || status === 'vencido';
}

/** «SOAT · WGY482», «Póliza · Seguros Bolívar», «Licencia». */
export function expirationTitle(input: {
  kind: ExpirationKind;
  subject?: string | null;
  issuer?: string | null;
  label?: string | null;
}): string {
  const head = input.label?.trim() || EXPIRATION_KIND_LABEL[input.kind];
  const tail = input.subject?.trim() || input.issuer?.trim();
  const title =
    tail && !head.toLowerCase().includes(tail.toLowerCase()) ? `${head} · ${tail}` : head;
  return title.slice(0, 200);
}

/** La clave del sujeto, idéntica a la columna generada de 0184. */
export function subjectKey(subject: string | null | undefined): string {
  return (subject ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Placa colombiana normalizada (ABC123 / ABC12D para motos), o null. */
export function normalizePlate(text: string | null | undefined): string | null {
  const compact = (text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{3}\d{2}[A-Z0-9]$/.test(compact) ? compact : null;
}

/** «vence en 12 días», «vence hoy», «venció hace 3 días», «sin fecha». */
export function daysPhrase(expiresOn: string | null, today: string): string {
  if (!expiresOn) return 'sin fecha';
  const left = daysBetween(today, expiresOn);
  if (Number.isNaN(left)) return 'sin fecha';
  if (left === 0) return 'vence hoy';
  if (left === 1) return 'vence mañana';
  if (left > 0) return `vence en ${left} días`;
  if (left === -1) return 'venció ayer';
  return `venció hace ${-left} días`;
}
