import { money } from '../autopilot/collectors';
import { plural } from '../commitments/shape';

/**
 * «TU DÍA»: EL RESUMEN DE LA MAÑANA, ESCRITO POR REGLAS (puro).
 *
 * Cortex habla primero: cada mañana hábil le cuenta a cada persona, en tres a
 * seis frases, lo que de verdad merece su atención. Sin modelo: es una plantilla
 * en español que recibe cifras ya leídas (ver load.ts). Mismo hecho, misma
 * frase; y se puede comprobar que dice la verdad, que es lo que un resumen que
 * suena solo necesita.
 *
 * Reglas:
 *   · Orden por urgencia: fuentes mudas, decisiones del piloto, vencidos,
 *     cartera, lo de hoy, trabajo atrasado.
 *   · Máximo 6 frases. Si no hay NADA que decir, no hay resumen (`send: false`):
 *     un «todo bien» diario enseña a no abrir la campana.
 *   · Los botones (`actions`) referencian cosas del piloto por su id y su huella;
 *     nunca una herramienta suelta. Como mucho dos.
 */

export const BRIEFING_MAX_BULLETS = 6;
export const BRIEFING_MAX_ACTIONS = 2;

/** Una cosa del piloto que espera decisión (o una anomalía reciente). */
export interface BriefingAsk {
  itemId: string;
  /** La huella de lo que se ejecutaría (la misma que `ItemDecision`). */
  contentHash: string;
  title: string;
  why: string;
  /** ¿Se puede aprobar con un clic desde el aviso? (tiene herramienta y no es un correo a un cliente) */
  actionable: boolean;
}

export interface BriefingCommitment {
  title: string;
  dueOn: string;
  counterparty: string | null;
  ownerName: string | null;
}

export interface BriefingInput {
  today: string;
  firstName: string | null;
  /** 'company': dueño o administrador, ve la empresa. 'person': sólo lo suyo. */
  scope: 'company' | 'person';
  overdueCommitments: BriefingCommitment[];
  dueTodayCommitments: BriefingCommitment[];
  workOverdue: Array<{ title: string; daysOverdue: number }>;
  receivables?: {
    overdueAmount: number;
    invoices: number;
    top: { who: string | null; amount: number; daysOverdue: number } | null;
  };
  asks: BriefingAsk[];
  anomalies: BriefingAsk[];
}

export interface BriefingAction {
  kind: 'autopilot_item';
  itemId: string;
  contentHash: string;
  /** Qué hace, para el botón y para el lector: el título de la cosa. */
  title: string;
}

export interface Briefing {
  send: boolean;
  title: string;
  /** Las frases, una por línea en el cuerpo del aviso. */
  bullets: string[];
  body: string;
  actions: BriefingAction[];
  tone: 'info' | 'warning';
  /** Cuántas cosas distintas contó (para el título). */
  topics: number;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** La primera frase de una explicación larga. */
function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return clip(m?.[1] ?? t, 220);
}

function daysOver(dueOn: string, today: string): number {
  const a = Date.parse(`${dueOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function list(titles: string[], max: number): string {
  const shown = titles.slice(0, max).map((t) => `«${clip(t, 50)}»`);
  const more = titles.length - shown.length;
  return more > 0
    ? `${shown.join(', ')} y ${more} más`
    : shown.join(', ').replace(/, ([^,]*)$/, ' y $1');
}

export function buildBriefing(input: BriefingInput): Briefing {
  const company = input.scope === 'company';
  const bullets: string[] = [];
  let topics = 0;
  const add = (sentence: string) => {
    topics += 1;
    if (bullets.length < BRIEFING_MAX_BULLETS) bullets.push(sentence);
  };

  // 1. Lo que se quedó mudo: lo más sorprendente, va primero.
  if (company && input.anomalies.length) {
    const [first, ...rest] = input.anomalies;
    add(
      `${firstSentence((first as BriefingAsk).why)}${rest.length ? ` Y ${plural(rest.length, 'aviso más', 'avisos más')} de fuentes que dejaron de llegar.` : ''}`,
    );
  }

  // 2. Decisiones que esperan en el piloto.
  if (company && input.asks.length) {
    const n = input.asks.length;
    add(
      n === 1
        ? `Hay 1 cosa esperando tu decisión en el piloto: ${clip((input.asks[0] as BriefingAsk).title, 90)}.`
        : `Hay ${n} cosas esperando tu decisión en el piloto, entre ellas ${list(
            input.asks.map((a) => a.title),
            2,
          )}.`,
    );
  }

  // 3. Compromisos vencidos.
  const overdue = [...input.overdueCommitments].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  if (overdue.length) {
    const oldest = overdue[0] as BriefingCommitment;
    const days = daysOver(oldest.dueOn, input.today);
    const who = company && oldest.ownerName ? `, de ${oldest.ownerName}` : '';
    add(
      `${company ? 'Hay' : 'Tienes'} ${plural(overdue.length, 'compromiso vencido', 'compromisos vencidos')}; el más viejo es «${clip(oldest.title, 70)}»${who}, de hace ${plural(days, 'día')}.`,
    );
  }

  // 4. Cartera.
  if (company && input.receivables && input.receivables.invoices > 0) {
    const r = input.receivables;
    const top = r.top
      ? `; la mayor, ${r.top.who ? `${clip(r.top.who, 40)} ` : ''}por ${money(r.top.amount)} (${plural(r.top.daysOverdue, 'día')} de mora)`
      : '';
    add(
      `La cartera vencida suma ${money(r.overdueAmount)} en ${plural(r.invoices, 'factura')}${top}.`,
    );
  }

  // 5. Lo que vence hoy.
  if (input.dueTodayCommitments.length) {
    add(
      `Hoy vence ${list(
        input.dueTodayCommitments.map((c) => c.title),
        3,
      )}.`,
    );
  }

  // 6. Trabajo atrasado (lo suyo).
  if (!company && input.workOverdue.length) {
    const worst = [...input.workOverdue].sort((a, b) => b.daysOverdue - a.daysOverdue)[0] as {
      title: string;
      daysOverdue: number;
    };
    add(
      `Tienes ${plural(input.workOverdue.length, 'tarea atrasada', 'tareas atrasadas')} en tu semana; la más atrasada es «${clip(worst.title, 70)}» (${plural(worst.daysOverdue, 'día')}).`,
    );
  }

  const actions: BriefingAction[] = company
    ? [...input.anomalies, ...input.asks]
        .filter((a) => a.actionable)
        .slice(0, BRIEFING_MAX_ACTIONS)
        .map((a) => ({
          kind: 'autopilot_item' as const,
          itemId: a.itemId,
          contentHash: a.contentHash,
          title: clip(a.title, 120),
        }))
    : [];

  const hello = input.firstName ? `, ${input.firstName}` : '';
  const title = bullets.length
    ? `Tu día${hello}: ${plural(topics, 'cosa', 'cosas')} para mirar`
    : `Tu día${hello}`;
  return {
    send: bullets.length > 0,
    title: clip(title, 160),
    bullets,
    body: clip(bullets.map((b) => `• ${b}`).join('\n'), 600),
    actions,
    tone: input.anomalies.length || input.asks.length || overdue.length ? 'warning' : 'info',
    topics,
  };
}
