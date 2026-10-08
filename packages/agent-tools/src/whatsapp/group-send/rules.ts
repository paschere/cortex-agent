import { compact, spaced } from '../../gdrive/folder-match';

/**
 * REGLAS PURAS DE «CORTEX ESCRIBE EN UN GRUPO» (migración 0213).
 *
 * El número de la empresa está vinculado como dispositivo (no es la API oficial
 * de WhatsApp Business) y WhatsApp puede bloquear números que escriben de forma
 * automática. Estos topes son, por eso, ESTRICTOS y viven en un solo lugar: los
 * aplica la herramienta al encolar, otra vez la entrega (latido) y, por último,
 * el puente en su propia memoria. Poco volumen, texto de persona.
 */

/** Mensajes de Cortex por grupo en la última hora. */
export const GROUP_SEND_PER_GROUP_PER_HOUR = 10;
/** Mensajes de Cortex por empresa en las últimas 24 horas (todos los grupos). */
export const GROUP_SEND_PER_ORG_PER_DAY = 50;
export const GROUP_SEND_MAX_CHARS = 1000;
/** Un mensaje que lleva más de esto en cola ya no sirve (la pregunta caducó). */
export const GROUP_SEND_MAX_QUEUE_AGE_MS = 30 * 60_000;
/** El mismo texto al mismo grupo: no antes de este tiempo. */
export const GROUP_SEND_REPEAT_WINDOW_MS = 10 * 60_000;
export const GROUP_INBOX_RETENTION_DAYS = 7;

export interface SendUsage {
  /** Mensajes de este grupo en la última hora (pendientes y enviados). */
  groupLastHour: number;
  /** Mensajes de toda la empresa en las últimas 24 horas. */
  orgLastDay: number;
}

/** null = puede; si no, la frase (en español) de por qué no. */
export function capRefusal(usage: SendUsage): string | null {
  if (usage.groupLastHour >= GROUP_SEND_PER_GROUP_PER_HOUR)
    return `Ya se mandaron ${GROUP_SEND_PER_GROUP_PER_HOUR} mensajes a ese grupo en la última hora (el tope, para no arriesgar el número). Intenta más tarde.`;
  if (usage.orgLastDay >= GROUP_SEND_PER_ORG_PER_DAY)
    return `La empresa ya mandó ${GROUP_SEND_PER_ORG_PER_DAY} mensajes a grupos en las últimas 24 horas (el tope). Intenta mañana.`;
  return null;
}

/** El texto tal como saldrá: sin espacios de más ni saltos en cadena. */
export function cleanOutgoingText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textRefusal(text: string): string | null {
  if (!text) return 'Escribe el mensaje.';
  if (text.length > GROUP_SEND_MAX_CHARS)
    return `El mensaje es muy largo (máximo ${GROUP_SEND_MAX_CHARS} caracteres); en un grupo se escribe corto.`;
  if ((text.match(/https?:\/\//gi) ?? []).length > 2)
    return 'Demasiados enlaces: un mensaje con varios enlaces parece spam y pone en riesgo el número.';
  return null;
}

/** ¿Es el mismo mensaje que ya se mandó hace poco a ese grupo? */
export function isRepeat(
  text: string,
  recent: Array<{ body: string; createdAt: string }>,
  now: Date,
): boolean {
  const key = compact(text);
  return recent.some(
    (r) =>
      now.getTime() - Date.parse(r.createdAt) < GROUP_SEND_REPEAT_WINDOW_MS &&
      compact(r.body) === key,
  );
}

export interface SendGroupRef {
  jid: string;
  subject: string | null;
}

export type GroupResolution =
  | { kind: 'found'; group: SendGroupRef }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: SendGroupRef[] };

/** Por jid exacto o por nombre tolerante (mayúsculas, tildes, guiones). */
export function resolveSendGroup(groups: SendGroupRef[], wanted: string): GroupResolution {
  const w = wanted.trim();
  const byJid = groups.find((g) => g.jid === w);
  if (byJid) return { kind: 'found', group: byJid };
  const wc = compact(w);
  if (!wc) return { kind: 'none' };
  const tiers: Array<(g: SendGroupRef) => boolean> = [
    (g) => compact(g.subject ?? '') === wc,
    (g) => ` ${spaced(g.subject ?? '')} `.includes(` ${spaced(w)} `),
    (g) => compact(g.subject ?? '').includes(wc),
  ];
  for (const t of tiers) {
    const hits = groups.filter(t);
    if (hits.length === 1) return { kind: 'found', group: hits[0] as SendGroupRef };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  }
  return { kind: 'none' };
}

/** Lo único que el puente acepta mandar: un grupo, con id válido, texto razonable. */
export const GROUP_JID_RE = /^[0-9]{5,}(-[0-9]+)?@g\.us$/;
