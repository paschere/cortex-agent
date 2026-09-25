import {
  type EscalationVia,
  type ManagerMap,
  escalationTarget,
  managerMapOf,
} from '../directory/line';
import type { ManagementCase, ManagementCaseData } from './shape';

/**
 * EL SEGUIMIENTO DE GERENCIA: la parte que persigue a la gente.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Gerencia prometía un gerente que insiste hasta que las cosas se cierran, y
 * hasta aquí sólo sabía MOSTRAR: la mesa priorizaba, el parte diario listaba y
 * el responsable de escalamiento aparecía con nombre y apellido sin que nadie le
 * escribiera nunca. Los únicos avisos vivían dentro de un ciclo de 30 días con
 * `notifyInApp` encendido, que viene apagado. Un asunto normal, vencido y con
 * dueño, podía pasar un mes en silencio.
 *
 * Esto copia lo que ya funciona en compromisos (commitments-watch, 0069): cada
 * mañana hábil, por empresa, se decide qué asuntos merecen un aviso, se reclama
 * el aviso en un libro con índice único, y sólo quien gana la reclamación
 * manda. Dos pasos, nada más:
 *
 *   1. owner       Al responsable, en la app y por correo: qué asunto, por qué
 *                  está en la lista, cuál es el próximo paso y el enlace.
 *   2. escalation  Si pasaron DOS DÍAS HÁBILES desde el aviso 1 y el asunto no
 *                  cambió de revisión, a quien está encima: el responsable de
 *                  escalamiento del perfil, o el jefe del responsable en la
 *                  línea de mando (0106), o el primer administrador. El
 *                  responsable se entera en la app de que se escaló.
 *
 *   unowned        Un asunto sin responsable no tiene a quién perseguir: va a
 *                  los administradores UNA sola vez en toda su vida, para que
 *                  alguien lo asigne. No escala: ya está arriba.
 *
 * ===========================================================================
 * QUÉ PONE UN ASUNTO EN LA LISTA
 * ===========================================================================
 * Sólo asuntos vivos que dependen del responsable: por organizar, en gestión o
 * bloqueados. «Por verificar» queda fuera a propósito — el responsable ya
 * entregó su evidencia y lo que falta es la revisión de un administrador, que
 * la mesa y el parte ya señalan. Perseguir a quien ya cumplió enseña a ignorar.
 *
 *   review_due     La próxima revisión acordada ya llegó.
 *   overdue        El plazo pasó Y nadie tocó el asunto desde entonces (o su
 *                  revisión también venció). Un asunto vencido que el
 *                  responsable actualizó después del plazo y al que le puso una
 *                  revisión futura está en gestión: se le vuelve a preguntar
 *                  cuando llegue esa fecha, no cada mañana.
 *   blocked_stale  Bloqueado y sin una sola revisión en 3 días hábiles.
 *   unowned        Sin responsable, o con uno que ya no está en la empresa.
 *
 * ===========================================================================
 * LA IDENTIDAD DE UN AVISO ES (asunto, revisión, paso)
 * ===========================================================================
 * Cualquier cambio guardado sube la revisión (management_save_case, 0130), así
 * que «el responsable respondió» se lee sin adivinar: la revisión ya no es la
 * del aviso. Si después de responder el asunto sigue en la lista, la revisión
 * nueva gana su propio aviso 1, y el reloj del escalado vuelve a empezar. Si no
 * respondió, la misma revisión cumple dos días hábiles y escala. El índice
 * único de la 0158 hace el resto: correr esto diez veces manda un aviso.
 *
 * ===========================================================================
 * DÍAS HÁBILES EN BOGOTÁ
 * ===========================================================================
 * Lunes a viernes, menos los festivos de Colombia (Ley 51 de 1983: fijos, los
 * que se corren al lunes, y los que cuelgan de la Pascua). Escalar el martes
 * después de un lunes festivo porque «ya pasaron dos días» es acusar a alguien
 * de no trabajar el día que la ley le dio libre. El cron tampoco corre en
 * festivos, por la misma razón.
 *
 * NUNCA SALE DE LA EMPRESA. Todo destinatario se resuelve contra el directorio
 * leído con el handle de la empresa; un id que no está ahí no recibe nada.
 * Cero llamadas al modelo: reglas y plantillas, igual que el resto de avisos.
 */

export type FollowUpReason = 'review_due' | 'overdue' | 'blocked_stale' | 'unowned';
export type FollowUpStep = 'owner' | 'escalation' | 'unowned';

/** Estados en los que el siguiente movimiento es del responsable. */
export const FOLLOW_UP_STATES = ['open', 'working', 'blocked'] as const;

/** Días hábiles sin una sola revisión para que un bloqueo cuente como abandonado. */
export const BLOCKED_STALE_BUSINESS_DAYS = 3;

/** Días hábiles entre el aviso al responsable y el escalado, si nadie respondió. */
export const ESCALATE_AFTER_BUSINESS_DAYS = 2;

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function shift(isoDate: string, days: number): string {
  return iso(new Date(toUtc(isoDate).getTime() + days * DAY_MS));
}

/** Domingo de Pascua (algoritmo anónimo gregoriano). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Ley Emiliani: si no cae en lunes, se corre al lunes siguiente. */
function nextMonday(isoDate: string): string {
  const dow = toUtc(isoDate).getUTCDay();
  return dow === 1 ? isoDate : shift(isoDate, (8 - dow) % 7);
}

const holidayCache = new Map<number, ReadonlySet<string>>();

/** Los 18 festivos nacionales de Colombia de un año. */
export function colombianHolidays(year: number): ReadonlySet<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const y = String(year);
  const easter = easterSunday(year);
  const set = new Set<string>([
    // Fijos
    `${y}-01-01`,
    `${y}-05-01`,
    `${y}-07-20`,
    `${y}-08-07`,
    `${y}-12-08`,
    `${y}-12-25`,
    // Se corren al lunes
    nextMonday(`${y}-01-06`),
    nextMonday(`${y}-03-19`),
    nextMonday(`${y}-06-29`),
    nextMonday(`${y}-08-15`),
    nextMonday(`${y}-10-12`),
    nextMonday(`${y}-11-01`),
    nextMonday(`${y}-11-11`),
    // Semana Santa, sin traslado
    shift(easter, -3),
    shift(easter, -2),
    // Cuelgan de la Pascua y se corren al lunes
    nextMonday(shift(easter, 39)),
    nextMonday(shift(easter, 60)),
    nextMonday(shift(easter, 68)),
  ]);
  holidayCache.set(year, set);
  return set;
}

export function isBusinessDay(isoDate: string): boolean {
  const date = toUtc(isoDate);
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !colombianHolidays(date.getUTCFullYear()).has(isoDate);
}

/**
 * Días hábiles en el intervalo (from, to]: el día del aviso no cuenta, el de
 * hoy sí. Aviso el lunes → el miércoles lleva 2. Aviso el viernes → el martes.
 * Cero o negativo si `to` no es posterior.
 */
export function businessDaysBetween(from: string, to: string): number {
  if (to <= from) return 0;
  let count = 0;
  // Tope de un año: nada de aquí mira más lejos, y un bucle sin techo sobre
  // una fecha corrupta sería un cron colgado.
  for (let day = shift(from, 1), n = 0; day <= to && n < 400; day = shift(day, 1), n++) {
    if (isBusinessDay(day)) count++;
  }
  return count;
}

/** El día de Bogotá de un timestamp (UTC-5 fijo; Colombia no cambia la hora). */
export function bogotaDateOf(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  return iso(new Date(ms - 5 * 3_600_000));
}

// ---------------------------------------------------------------------------
// Qué pone a un asunto en la lista
// ---------------------------------------------------------------------------

/**
 * Por qué este asunto merece un aviso hoy. Vacío = nada que decir.
 *
 * @param touchedOn día de Bogotá de la última revisión guardada.
 * @param ownerPresent el responsable existe Y sigue en el directorio.
 */
export function followUpReasons(
  data: Pick<ManagementCaseData, 'state' | 'ownerId' | 'dueOn' | 'nextReviewOn'>,
  touchedOn: string,
  today: string,
  ownerPresent = Boolean(data.ownerId),
): FollowUpReason[] {
  if (!(FOLLOW_UP_STATES as readonly string[]).includes(data.state)) return [];
  const reasons: FollowUpReason[] = [];
  if (!ownerPresent) reasons.push('unowned');
  const reviewDue = data.nextReviewOn <= today;
  if (reviewDue) reasons.push('review_due');
  if (data.dueOn < today && (reviewDue || !touchedOn || touchedOn <= data.dueOn))
    reasons.push('overdue');
  if (
    data.state === 'blocked' &&
    businessDaysBetween(touchedOn || today, today) >= BLOCKED_STALE_BUSINESS_DAYS
  )
    reasons.push('blocked_stale');
  // Sin responsable basta por sí solo, aunque el asunto esté en su plazo: uno
  // creado ayer sin dueño es justo el que conviene asignar antes de que venza.
  return reasons;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «4 de septiembre». El año sobra en un aviso de esta semana. */
export function shortSpanishDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${Number(d)} de ${MONTHS[Number(m) - 1] ?? m}`;
}

/** Una frase por motivo, escrita con reglas. La misma en la app y en el correo. */
export function followUpReasonText(
  reason: FollowUpReason,
  data: Pick<ManagementCaseData, 'dueOn' | 'nextReviewOn'>,
  touchedOn: string,
): string {
  switch (reason) {
    case 'review_due':
      return `La revisión acordada era el ${shortSpanishDate(data.nextReviewOn)}.`;
    case 'overdue':
      return `El plazo venció el ${shortSpanishDate(data.dueOn)}.`;
    case 'blocked_stale':
      return `Está bloqueado sin novedades desde el ${shortSpanishDate(touchedOn)}.`;
    case 'unowned':
      return 'No tiene responsable asignado.';
  }
}

// ---------------------------------------------------------------------------
// Quién recibe qué, hoy
// ---------------------------------------------------------------------------

/** Una fila del libro de avisos (0158), lo mínimo para decidir. */
export interface FollowUpNotice {
  caseId: string;
  caseRevision: number;
  step: FollowUpStep;
  sentOn: string;
  delivered: boolean;
}

/** Una persona del directorio de la empresa, en orden de antigüedad. */
export interface FollowUpPerson {
  id: string;
  role: string;
  managerId: string | null;
}

export interface PlannedFollowUp {
  caseId: string;
  caseRevision: number;
  step: FollowUpStep;
  reasons: FollowUpReason[];
  /** Día de Bogotá de la última revisión, para redactar «desde el…». */
  touchedOn: string;
  /** Quiénes reciben el aviso (app + correo). Siempre miembros de la empresa. */
  recipients: string[];
  /** Quiénes sólo se enteran en la app de que el aviso salió (el responsable, al escalar). */
  cc: string[];
  /** Por dónde se resolvió el escalado. Nulo en los otros pasos. */
  via: EscalationVia | null;
  /** Día en que salió el aviso 1, para decirlo en el escalado. */
  firstNoticeOn: string | null;
}

export interface FollowUpPlanInput {
  cases: readonly ManagementCase[];
  notices: readonly FollowUpNotice[];
  /** El directorio completo de la empresa, en orden de antigüedad (listDirectory). */
  people: readonly FollowUpPerson[];
  /** `management_profiles.data.escalationOwnerId`. */
  escalationOwnerId: string | null;
  today: string;
}

/**
 * La clave de un aviso: la misma para el libro y para la bandeja de la app.
 * El de «sin responsable» no lleva revisión porque sale una sola vez por asunto.
 */
export function followUpKey(caseId: string, revision: number, step: FollowUpStep): string {
  return `management-case:${caseId}:${step}:${step === 'unowned' ? 'once' : revision}`;
}

/**
 * El plan del día, sin base de datos de por medio.
 *
 * Un aviso ya reclamado pero no entregado se vuelve a planear: la reclamación
 * lo devuelve como reintento y no se crea otra fila. Como máximo un mensaje,
 * como mínimo un intento — la regla de la 0069.
 */
export function planFollowUps(input: FollowUpPlanInput): PlannedFollowUp[] {
  const { today } = input;
  const members = new Set(input.people.map((p) => p.id));
  const admins = input.people.filter((p) => p.role === 'org_admin').map((p) => p.id);
  const managers: ManagerMap = managerMapOf(
    input.people.map((p) => ({ id: p.id, managerId: p.managerId })),
  );
  const delivered = (caseId: string, step: FollowUpStep, revision?: number) =>
    input.notices.find(
      (n) =>
        n.caseId === caseId &&
        n.step === step &&
        n.delivered &&
        (revision === undefined || n.caseRevision === revision),
    ) ?? null;

  const plan: PlannedFollowUp[] = [];
  for (const item of input.cases) {
    const touchedOn = bogotaDateOf(item.updated_at);
    const owner = item.data.ownerId && members.has(item.data.ownerId) ? item.data.ownerId : null;
    const reasons = followUpReasons(item.data, touchedOn, today, owner !== null);
    if (reasons.length === 0) continue;
    const base = {
      caseId: item.id,
      caseRevision: item.revision,
      reasons,
      touchedOn,
      cc: [] as string[],
      via: null,
      firstNoticeOn: null,
    };

    if (!owner) {
      if (delivered(item.id, 'unowned')) continue;
      if (admins.length === 0) continue;
      plan.push({ ...base, step: 'unowned', recipients: admins });
      continue;
    }

    const first = delivered(item.id, 'owner', item.revision);
    if (!first) {
      plan.push({ ...base, step: 'owner', recipients: [owner] });
      continue;
    }
    if (businessDaysBetween(first.sentOn, today) < ESCALATE_AFTER_BUSINESS_DAYS) continue;
    if (delivered(item.id, 'escalation', item.revision)) continue;

    // El nombrado en el perfil gana, salvo que sea el propio responsable o ya
    // no esté en la empresa: escalarle a quien no respondió no es escalar.
    const named =
      input.escalationOwnerId &&
      input.escalationOwnerId !== owner &&
      members.has(input.escalationOwnerId)
        ? input.escalationOwnerId
        : null;
    const target = escalationTarget({
      escalateToUserId: named,
      ownerUserId: owner,
      managers,
      admins: admins.filter((a) => a !== owner),
    });
    if (!target.userId || target.userId === owner) continue;
    plan.push({
      ...base,
      step: 'escalation',
      recipients: [target.userId],
      cc: [owner],
      via: target.via,
      firstNoticeOn: first.sentOn,
    });
  }
  return plan;
}
