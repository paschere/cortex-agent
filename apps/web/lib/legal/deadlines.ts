import { colombianHolidays } from '@cortex/agent-tools';

/**
 * PLAZOS LEGALES EN DÍAS HÁBILES COLOMBIANOS.
 *
 * Ley 1581 de 2012:
 *   art. 14  CONSULTA  — se responde en máximo 10 días hábiles desde el día
 *            siguiente a recibirla. Si no se puede, se avisa el motivo y la
 *            nueva fecha, que no puede pasar de 5 días hábiles más.
 *   art. 15  RECLAMO   — 15 días hábiles desde el día siguiente al recibo
 *            (completo). Si no se puede, se avisa y se prorroga hasta 8 días
 *            hábiles más. Un reclamo incompleto se devuelve en 5 días para que
 *            se complete; si en 2 meses no se completa, se entiende desistido.
 *
 * «Hábil» = lunes a viernes menos los festivos nacionales. Los festivos salen
 * del mismo cálculo que ya usa el seguimiento de Gerencia
 * (management/follow-up.ts: Ley 51 de 1983 y Pascua) más el festivo nuevo de
 * la Ley 2578 de 2026 (9 de julio corrido al lunes), que ese cálculo todavía no
 * tiene y el calendario tributario sí (tax/calendar-co.ts). No se añade el Día
 * Cívico de abril: ése es un día no hábil de la DIAN, no un festivo nacional.
 *
 * El día de recibo se toma en hora de Bogotá (UTC-5 fijo). Una solicitud que
 * llega un sábado a las 11 p. m. se recibió el sábado; el conteo empieza el
 * lunes hábil siguiente.
 */

export type LegalRequestKind = 'consulta' | 'reclamo';

export const LEGAL_TERM_BUSINESS_DAYS: Readonly<Record<LegalRequestKind, number>> = {
  consulta: 10,
  reclamo: 15,
};

export const LEGAL_EXTENSION_BUSINESS_DAYS: Readonly<Record<LegalRequestKind, number>> = {
  consulta: 5,
  reclamo: 8,
};

const DAY_MS = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function shift(isoDate: string, days: number): string {
  return iso(new Date(toUtc(isoDate).getTime() + days * DAY_MS));
}
function nextMonday(isoDate: string): string {
  const dow = toUtc(isoDate).getUTCDay();
  return dow === 1 ? isoDate : shift(isoDate, (8 - dow) % 7);
}

const cache = new Map<number, ReadonlySet<string>>();

/** Festivos nacionales de un año, con los que añadió la Ley 2578 de 2026. */
export function legalHolidays(year: number): ReadonlySet<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const set = new Set(colombianHolidays(year));
  if (year >= 2026) set.add(nextMonday(`${year}-07-09`));
  cache.set(year, set);
  return set;
}

export function isLegalBusinessDay(isoDate: string): boolean {
  const dow = toUtc(isoDate).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !legalHolidays(toUtc(isoDate).getUTCFullYear()).has(isoDate);
}

/**
 * El n-ésimo día hábil DESPUÉS de `fromIso` (el propio día no cuenta). n=0
 * devuelve el mismo día. Tope de 400 iteraciones contra fechas corruptas.
 */
export function addBusinessDays(fromIso: string, n: number): string {
  let day = fromIso;
  let left = n;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    day = shift(day, 1);
    if (isLegalBusinessDay(day)) left--;
  }
  return day;
}

/** El día de Bogotá de un instante. */
export function bogotaDate(at: Date): string {
  return iso(new Date(at.getTime() - 5 * 3_600_000));
}

/** Fecha límite legal para responder una solicitud recibida en `receivedAt`. */
export function legalDueDate(kind: LegalRequestKind, receivedAt: Date): string {
  return addBusinessDays(bogotaDate(receivedAt), LEGAL_TERM_BUSINESS_DAYS[kind]);
}

/** Hasta dónde puede llegar la prórroga, contada desde el vencimiento inicial. */
export function legalExtendedDueDate(kind: LegalRequestKind, dueOn: string): string {
  return addBusinessDays(dueOn, LEGAL_EXTENSION_BUSINESS_DAYS[kind]);
}

/** Días hábiles que faltan hasta `dueOn` contando desde `today` (negativo si venció). */
export function businessDaysLeft(today: string, dueOn: string): number {
  if (dueOn === today) return 0;
  const forward = dueOn > today;
  const [from, to] = forward ? [today, dueOn] : [dueOn, today];
  let count = 0;
  for (let d = shift(from, 1), guard = 0; d <= to && guard < 800; d = shift(d, 1), guard++) {
    if (isLegalBusinessDay(d)) count++;
  }
  return forward ? count : -count;
}
