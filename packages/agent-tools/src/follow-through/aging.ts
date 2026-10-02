/**
 * LO QUE LLEVA DÍAS ESPERANDO TU VISTO BUENO.
 *
 * Una propuesta (`public.actions`, 0077) vive siete días. Hasta ahora pasaban
 * tres cosas con ella: alguien la aprobaba, el jefe recibía un aviso a las 48 h
 * (actions/escalation.ts), o vencía en silencio. La tercera es la peor: el
 * borrador desaparece de la pantalla y nadie decidió nada — ni mandarlo ni no
 * mandarlo.
 *
 * Esto añade dos pasos, ambos a QUIEN TIENE QUE DECIDIR (nunca a otro):
 *
 *   reminder  A las 24 h: «Tienes 6 borradores esperando tu visto bueno; el
 *             más viejo lleva dos días». UNO por persona y día, nunca uno por
 *             borrador — seis avisos por seis cobros parecidos es exactamente
 *             el ruido que enseña a no abrir la campana.
 *   discard   A los cinco días: «¿Los descarto?». Una pregunta clara antes de
 *             que expiren solos a los siete, cuando todavía hay dos días para
 *             contestar. Una vez por borrador en toda su vida.
 *
 * La otra cola (`mcp_pending_actions`) vive quince minutos y no entra aquí por
 * la misma razón que no entra en el escalado: cuando un barrido diario la mira,
 * todo lo que había ya expiró.
 *
 * Puro: filas, un instante y lo ya reclamado entran; una lista sale.
 */

/** Horas parada antes del primer recordatorio. Un día completo: lo de ayer ya no es «nuevo». */
export const APPROVAL_REMIND_AFTER_HOURS = 24;

/**
 * Días parada antes de preguntar «¿lo descarto?». Cinco, porque la propuesta
 * vive siete (PROPOSAL_TTL_MS): deja dos días para contestar antes de que venza
 * sola, y ya pasó el aviso al jefe de las 48 h.
 */
export const APPROVAL_DISCARD_AFTER_DAYS = 5;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface AgingAction {
  id: string;
  userId: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  /** «Cobro de cartera a Nexa»: lo que dirá el aviso. */
  headline: string;
}

export type AgingStep = 'reminder' | 'discard';

export interface AgingPlan {
  userId: string;
  step: AgingStep;
  /** La identidad del aviso en `follow_through_notices`: el día o el borrador. */
  refs: string[];
  actionIds: string[];
  headlines: string[];
  /** Horas completas que lleva el más viejo. */
  oldestHours: number;
}

export interface AgingInput {
  actions: readonly AgingAction[];
  now: Date;
  /** El día de Bogotá: la identidad del recordatorio diario. */
  today: string;
  /** Lo ya avisado: `${userId}|${kind}|${ref}`. */
  claimed: ReadonlySet<string>;
  remindAfterHours?: number;
  discardAfterDays?: number;
}

export function agingClaimKey(
  userId: string,
  kind: 'approval_reminder' | 'approval_discard',
  ref: string,
): string {
  return `${userId}|${kind}|${ref}`;
}

/**
 * Qué se avisa hoy y a quién.
 *
 * Una propuesta que ya cruzó los cinco días va al «¿lo descarto?» y NO cuenta
 * en el recordatorio del mismo día: decirle a alguien en dos avisos lo mismo de
 * la misma fila es duplicar. Una propuesta vencida, decidida o con fecha
 * ilegible se ignora — avisar de algo que ya no se puede aprobar es pedir lo
 * imposible.
 */
export function planApprovalAging(input: AgingInput): AgingPlan[] {
  const now = input.now.getTime();
  const remindAfter = (input.remindAfterHours ?? APPROVAL_REMIND_AFTER_HOURS) * HOUR;
  const discardAfter = (input.discardAfterDays ?? APPROVAL_DISCARD_AFTER_DAYS) * DAY;

  const reminders = new Map<string, Array<{ a: AgingAction; age: number }>>();
  const discards = new Map<string, Array<{ a: AgingAction; age: number }>>();

  for (const a of input.actions) {
    if (a.state !== 'proposed') continue;
    const created = Date.parse(a.createdAt);
    const expires = Date.parse(a.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expires)) continue;
    if (expires <= now) continue;
    const age = now - created;
    if (age < remindAfter) continue;
    if (age >= discardAfter) {
      if (input.claimed.has(agingClaimKey(a.userId, 'approval_discard', a.id))) continue;
      const list = discards.get(a.userId) ?? [];
      list.push({ a, age });
      discards.set(a.userId, list);
    } else {
      const list = reminders.get(a.userId) ?? [];
      list.push({ a, age });
      reminders.set(a.userId, list);
    }
  }

  const plans: AgingPlan[] = [];
  const oldestFirst = (x: { a: AgingAction; age: number }, y: { a: AgingAction; age: number }) =>
    y.age - x.age || x.a.id.localeCompare(y.a.id);

  for (const [userId, list] of discards) {
    list.sort(oldestFirst);
    plans.push({
      userId,
      step: 'discard',
      refs: list.map((x) => x.a.id),
      actionIds: list.map((x) => x.a.id),
      headlines: list.map((x) => x.a.headline),
      oldestHours: Math.floor((list[0]?.age ?? 0) / HOUR),
    });
  }
  for (const [userId, list] of reminders) {
    if (input.claimed.has(agingClaimKey(userId, 'approval_reminder', input.today))) continue;
    list.sort(oldestFirst);
    plans.push({
      userId,
      step: 'reminder',
      refs: [input.today],
      actionIds: list.map((x) => x.a.id),
      headlines: list.map((x) => x.a.headline),
      oldestHours: Math.floor((list[0]?.age ?? 0) / HOUR),
    });
  }
  return plans.sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) || (a.step === b.step ? 0 : a.step === 'discard' ? -1 : 1),
  );
}

const CARDINAL = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
];

/** «un día», «dos días», «12 días». */
export function daysWaitingPhrase(hours: number): string {
  const days = Math.max(1, Math.floor(hours / 24));
  if (days === 1) return 'un día';
  return `${CARDINAL[days] ?? String(days)} días`;
}

/** La edad de algo pendiente, dicha para una lista: «lleva dos días esperando». */
export function waitingAgePhrase(createdAt: string, now: Date): string | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  const hours = (now.getTime() - created) / HOUR;
  if (hours < 24) return null;
  return `lleva ${daysWaitingPhrase(hours)} esperando`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listHeadlines(headlines: readonly string[], max = 3): string {
  const shown = headlines.slice(0, max).map((h) => `«${h}»`);
  const rest = headlines.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} y ${count(rest, 'otro', 'otros')}`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} y ${shown[shown.length - 1]}`;
}

/** El aviso, escrito con reglas: título, cuerpo y a dónde ir. */
export function agingNotice(plan: AgingPlan): { title: string; body: string; href: string } {
  const n = plan.actionIds.length;
  if (plan.step === 'discard') {
    return {
      title:
        n === 1
          ? `Un borrador lleva ${daysWaitingPhrase(plan.oldestHours)} esperando: ¿lo descarto?`
          : `${count(n, 'borrador lleva', 'borradores llevan')} más de cinco días esperando: ¿los descarto?`,
      body: `${listHeadlines(plan.headlines)}. Las cifras que traen se están quedando viejas: apruébalos o descártalos en Acciones; si no, vencen solos a los siete días.`,
      href: '/actions?viejos=1',
    };
  }
  return {
    title: `Tienes ${count(n, 'borrador', 'borradores')} esperando tu visto bueno`,
    body: `El más viejo lleva ${daysWaitingPhrase(plan.oldestHours)}: ${listHeadlines(plan.headlines)}. Los parecidos se aprueban de una vez en Acciones.`,
    href: '/actions',
  };
}
