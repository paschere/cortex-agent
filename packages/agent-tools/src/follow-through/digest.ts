import { withinQuietHours } from '../mail/alerts';
import { isBusinessDay } from '../management/follow-up';
import { instantMs } from '../work/metrics';
import type { WorkItem } from '../work/types';

/**
 * EL RESUMEN DIARIO DE LO VENCIDO, POR PERSONA: «TIENES 3 VENCIDOS: …».
 *
 * El registro de trabajo (0174) ya sabe qué tiene cada quien vencido: casos de
 * Gerencia, compromisos, filas de tablas con responsable. Lo que no hacía era
 * decírselo a la persona: había que entrar a /team/yo. Y la alternativa obvia
 * —un aviso por ítem vencido— es la que convierte la campana en ruido: quien
 * tiene once vencidos recibe once avisos y deja de abrirla.
 *
 * Así que es UNO al día por persona, con lo más vencido arriba, y sólo:
 *
 *   · en días hábiles de Colombia (lunes a viernes sin festivos: nadie quiere
 *     el sábado una lista de lo que no hizo el viernes),
 *   · dentro de la franja en que esa persona acepta que la interrumpan (la
 *     misma de los avisos del buzón, 0126; 07:00–21:00 si no la cambió),
 *   · si no está fuera ese día (vacaciones, incapacidad: work_people_meta),
 *   · y si la empresa no lo apagó (`work_settings.overdue_digest`).
 *
 * El aviso es para el responsable y habla SÓLO de lo suyo. Nunca se le cuenta
 * a nadie lo vencido de otro: eso es el escalado de Gerencia, con sus reglas.
 *
 * Puro: ítems, personas, un instante y lo ya enviado hoy entran; avisos salen.
 */

/** Cuántos ítems se nombran en el aviso. El resto va como «y N más». */
export const DIGEST_LINES = 5;

export interface DigestRecipient {
  id: string;
  name: string;
  timezone: string;
  /** La franja en que se le puede avisar, «HH:MM». */
  windowFrom: string;
  windowTo: string;
  /** Días fuera (YYYY-MM-DD). */
  awayDays?: readonly string[];
}

export interface DigestLine {
  itemId: string;
  title: string;
  /** Días completos de vencido al día de hoy (1 = venció ayer). */
  daysOverdue: number;
}

export interface DigestPlan {
  userId: string;
  count: number;
  lines: DigestLine[];
  /** «Tienes 3 vencidos: Despacho a Nexa, Cobro FV-12 y uno más.» */
  title: string;
  body: string;
}

export interface DigestInput {
  items: readonly WorkItem[];
  recipients: ReadonlyMap<string, DigestRecipient>;
  /** Día de Bogotá. */
  today: string;
  now: Date;
  /** Personas a quienes ya se les mandó hoy. */
  alreadySent: ReadonlySet<string>;
  enabled: boolean;
}

const DAY_MS = 86_400_000;

/** El día (Bogotá) del vencimiento: un día tal cual, un instante convertido. */
export function dueDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = instantMs(v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** Días completos entre el vencimiento y hoy. Cero o menos: todavía no vence. */
export function daysOverdue(dueDay: string, today: string): number {
  const a = Date.parse(`${dueDay}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
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
const word = (n: number) => CARDINAL[n] ?? String(n);

function overduePhrase(days: number): string {
  if (days <= 1) return 'venció ayer';
  return `vencido hace ${word(days)} días`;
}

function clip(text: string, max = 70): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** La frase de arriba. Las mismas entradas dan siempre la misma oración. */
export function digestTitle(count: number, lines: readonly DigestLine[]): string {
  if (count === 1 && lines[0]) return `Tienes un vencido: ${clip(lines[0].title)}`;
  const names = lines.slice(0, 2).map((l) => clip(l.title, 48));
  const rest = count - names.length;
  const head = `Tienes ${count} vencidos`;
  if (names.length === 0) return `${head}.`;
  if (rest <= 0) return `${head}: ${names.join(' y ')}`;
  return `${head}: ${names.join(', ')} y ${rest === 1 ? 'uno más' : `${rest} más`}`;
}

/** Qué resumen le toca a cada quien hoy. */
export function planOverdueDigests(input: DigestInput): DigestPlan[] {
  if (!input.enabled) return [];
  if (!isBusinessDay(input.today)) return [];

  const byPerson = new Map<string, DigestLine[]>();
  for (const item of input.items) {
    if (item.status !== 'open' || !item.assigneeId) continue;
    const due = dueDayOf(item.dueAt);
    if (!due) continue;
    const days = daysOverdue(due, input.today);
    if (days < 1) continue;
    const list = byPerson.get(item.assigneeId) ?? [];
    list.push({ itemId: item.id, title: item.title, daysOverdue: days });
    byPerson.set(item.assigneeId, list);
  }

  const plans: DigestPlan[] = [];
  for (const [userId, all] of byPerson) {
    if (input.alreadySent.has(userId)) continue;
    const person = input.recipients.get(userId);
    // Alguien que ya no está en el directorio no recibe nada: no hay a quién.
    if (!person) continue;
    if (person.awayDays?.includes(input.today)) continue;
    if (!withinQuietHours(input.now, person.timezone, person.windowFrom, person.windowTo)) continue;
    all.sort(
      (a, b) =>
        b.daysOverdue - a.daysOverdue ||
        a.title.localeCompare(b.title, 'es') ||
        a.itemId.localeCompare(b.itemId),
    );
    const lines = all.slice(0, DIGEST_LINES);
    const more = all.length - lines.length;
    const body = [
      ...lines.map((l) => `• ${clip(l.title, 90)} — ${overduePhrase(l.daysOverdue)}`),
      more > 0 ? `y ${more} más en tu semana.` : null,
      'Ciérralos, ponles fecha nueva o pide ayuda desde Mi semana.',
    ]
      .filter(Boolean)
      .join('\n');
    plans.push({ userId, count: all.length, lines, title: digestTitle(all.length, lines), body });
  }
  return plans.sort((a, b) => a.userId.localeCompare(b.userId));
}
