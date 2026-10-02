import { formatValue } from '../../views/compute';
import type { PulseFact } from '../../views/pulse';
import type { RecommendationRecord } from './shape';

/**
 * «LO QUE RECOMENDÉ Y QUÉ PASÓ», ESCRITO CON REGLAS.
 *
 *   Recomendé cobrarle primero a Nexa: se envió el cobro el martes y pagó
 *   $ 12.000.000 el jueves.
 *   Recomendé repartir los despachos de Laura: no se hizo; sigue con 15
 *   abiertos.
 *
 * Por qué sin modelo: cada cifra de estas frases sale de un hecho guardado (el
 * pago en el libro, la carga de hoy en el registro), y la frase existe para que
 * alguien la pueda comprobar. Un modelo la diría distinta cada semana. Así que
 * se arma aquí, y cada número que lleva se publica además como cifra citable
 * (`facts`), con la misma forma que las del pulso: la revisión semanal sigue
 * cumpliendo «todo número está en las cifras».
 *
 * Nunca dice «gracias a». Dice lo que se hizo y lo que pasó después, unidos
 * por «y» o por «; igual», y nada más.
 *
 * Los días se dicen con su nombre («el martes», «el jueves de la semana
 * pasada»), nunca con números: la guarda de cifras no admite fechas.
 */

const WEEKDAY = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_MS = 86_400_000;

function dayOf(iso: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** «hoy», «ayer», «el martes», «el martes de la semana pasada», «hace semanas». */
export function followUpWhen(iso: string | null | undefined, today: string): string {
  if (!iso) return '';
  const day = dayOf(iso);
  if (!day) return '';
  const diff = Math.round(
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / DAY_MS,
  );
  if (diff <= 0) return 'hoy';
  if (diff === 1) return 'ayer';
  const name = WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? '';
  if (diff <= 6) return `el ${name}`;
  if (diff <= 13) return `el ${name} de la semana pasada`;
  return 'hace semanas';
}

function money(amount: number, currency: string | null | undefined): string {
  if (!currency || currency === 'COP') return formatValue(amount, 'money');
  return `${currency} ${formatValue(amount, 'number')}`;
}

const n = (v: number) => formatValue(v, 'number');

interface Piece {
  text: string;
  facts: Array<{ suffix: string; label: string; value: number; display: string }>;
}

const piece = (text: string, facts: Piece['facts'] = []): Piece => ({ text, facts });

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Lo que se hizo (o no). */
function followPiece(r: RecommendationRecord, today: string): Piece | null {
  const f = r.followEvidence ?? {};
  const when = followUpWhen(f.at ?? r.followedAt, today);
  const o = r.outcomeEvidence ?? {};
  switch (r.kind) {
    case 'collect_counterparty':
      if (r.status === 'followed') return piece(`se envió el cobro ${when}`.trim());
      if (r.status === 'in_progress')
        return piece('el cobro está redactado y espera tu visto bueno');
      if (r.status === 'not_followed') return piece('no se envió el cobro');
      return null;
    case 'collect_overdue':
    case 'cash_alert':
      if (r.status === 'followed' && f.count)
        return piece(
          `salieron ${n(f.count)} ${plural(f.count, 'cobro', 'cobros')} desde entonces`,
          [
            {
              suffix: 'cobros',
              label: 'Cobros enviados después de la recomendación',
              value: f.count,
              display: n(f.count),
            },
          ],
        );
      if (r.status === 'not_followed') return piece('no salió ningún cobro');
      return null;
    case 'review_approvals':
      if (r.status === 'followed' && f.count)
        return piece(`se ${plural(f.count, 'decidió', 'decidieron')} ${n(f.count)} después`, [
          {
            suffix: 'decididas',
            label: 'Aprobaciones decididas después',
            value: f.count,
            display: n(f.count),
          },
        ]);
      if (r.status === 'not_followed') return piece('nadie las decidió');
      return null;
    case 'fix_routine':
      if (r.status === 'followed') return piece(`se cambió la rutina ${when}`.trim());
      if (r.status === 'not_followed') return piece('nadie la tocó');
      return null;
    case 'close_commitments':
    case 'decide_cases':
    case 'clear_overdue_person':
    case 'assign_unassigned':
      // Lo que se hizo y lo que pasó son la misma cifra: se dice en el desenlace.
      if (r.status === 'not_followed') return piece('no se hizo');
      return null;
    case 'rebalance_person':
      if (r.status === 'followed' || r.status === 'in_progress')
        return piece(`se reasignó trabajo ${when}`.trim());
      if (r.status === 'not_followed') return piece('no se hizo');
      return null;
    case 'management_case':
    case 'revive_stale':
      if (r.status === 'followed') return piece(`se movió ${when}`.trim());
      if (r.status === 'not_followed')
        return piece(o.what === 'closed' ? 'no se tocó' : 'no se movió');
      return null;
    default:
      return null;
  }
}

/** Lo que pasó después. */
function outcomePiece(r: RecommendationRecord, today: string): Piece | null {
  const o = r.outcomeEvidence ?? {};
  const from = typeof o.from === 'number' ? o.from : null;
  const to = typeof o.to === 'number' ? o.to : null;
  const countFacts = (label: string): Piece['facts'] => [
    ...(from !== null
      ? [
          {
            suffix: 'antes',
            label: `${label} el día de la recomendación`,
            value: from,
            display: n(from),
          },
        ]
      : []),
    ...(to !== null ? [{ suffix: 'hoy', label: `${label} hoy`, value: to, display: n(to) }] : []),
  ];
  // «bajó» habla de una persona (Laura bajó de 15 a 9 abiertos); «bajaron»
  // de cosas de la empresa (los compromisos bajaron de 6 a 2).
  const moved = (noun: string, label: string, plural = false): Piece | null => {
    if (from === null || to === null) return null;
    const [down, up, same] = plural
      ? ['bajaron', 'subieron', 'siguen']
      : ['bajó', 'subió', 'sigue con'];
    if (to < from) return piece(`${down} de ${n(from)} a ${n(to)} ${noun}`, countFacts(label));
    if (to > from) return piece(`${up} de ${n(from)} a ${n(to)} ${noun}`, countFacts(label));
    return piece(`${same} ${n(to)} ${noun}`, countFacts(label));
  };
  switch (r.kind) {
    case 'collect_counterparty':
    case 'collect_overdue': {
      if (o.what === 'payment' && typeof o.amount === 'number' && o.amount > 0) {
        const display = money(o.amount, o.currency);
        const when = followUpWhen(o.at, today);
        const text =
          r.kind === 'collect_counterparty'
            ? `pagó ${display} ${when}`
            : `entraron ${display} en pagos desde entonces`;
        return piece(text.trim(), [
          {
            suffix: 'pago',
            label: 'Plata que entró después de la recomendación',
            value: o.amount,
            display,
          },
        ]);
      }
      if (r.outcome === 'none') return piece('no se ve un pago en el mes siguiente');
      if (r.outcome === 'pending') return piece('todavía no se ve un pago');
      return null;
    }
    case 'cash_alert':
      if (o.what === 'alert_gone') return piece('la alerta ya no aparece en la proyección de caja');
      if (o.what === 'alert_still') return piece('la alerta sigue en la proyección de caja');
      return null;
    case 'review_approvals':
      if (from === null || to === null) return null;
      return piece(
        `quedan ${n(to)} esperando (eran ${n(from)})`,
        countFacts('Aprobaciones esperando'),
      );
    case 'fix_routine':
      if (o.what === 'no_errors') return piece('no ha vuelto a fallar');
      if (o.what === 'errors' && to)
        return piece(`falló ${n(to)} ${plural(to, 'vez', 'veces')} más`, [
          { suffix: 'errores', label: 'Errores de la rutina después', value: to, display: n(to) },
        ]);
      return null;
    case 'close_commitments':
      return moved(
        plural(to ?? 0, 'compromiso vencido', 'compromisos vencidos'),
        'Compromisos vencidos',
        true,
      );
    case 'decide_cases':
      return moved(
        plural(to ?? 0, 'asunto abierto', 'asuntos abiertos'),
        'Asuntos abiertos de Gerencia',
        true,
      );
    case 'rebalance_person':
      return moved(
        plural(to ?? 0, 'abierto', 'abiertos'),
        `Abiertos de ${r.subjectLabel ?? 'la persona'}`,
      );
    case 'clear_overdue_person':
      return moved(
        plural(to ?? 0, 'vencido', 'vencidos'),
        `Vencidos de ${r.subjectLabel ?? 'la persona'}`,
      );
    case 'assign_unassigned':
      return moved('sin responsable', 'Abiertos sin responsable', true);
    case 'management_case':
    case 'revive_stale':
      if (o.what === 'closed') return piece('ya se cerró');
      return null;
    default:
      return null;
  }
}

export interface FollowUpSentence {
  id: string;
  text: string;
  facts: PulseFact[];
}

/**
 * La frase de una recomendación pasada, o `null` si todavía no hay nada que
 * contar (recién hecha, o sin forma de medirla).
 */
export function followUpSentence(
  r: RecommendationRecord,
  today: string,
  index = 0,
): FollowUpSentence | null {
  if (r.status === 'open' || r.status === 'unmeasurable') {
    // Abierta pero con un desenlace que contar (pagó sin que nadie cobrara):
    // eso sí se dice.
    if (!(r.status === 'open' && r.outcome === 'good')) return null;
  }
  const follow = followPiece(r, today);
  const outcome = outcomePiece(r, today);
  if (!follow && !outcome) return null;
  let tail: string;
  if (follow && outcome) {
    if (r.status === 'not_followed')
      tail =
        r.outcome === 'good'
          ? `${follow.text}; igual ${outcome.text}`
          : `${follow.text}; ${outcome.text}`;
    else if (r.outcome === 'good' || r.outcome === 'worse')
      tail = `${follow.text} y ${outcome.text}`;
    else tail = `${follow.text}; ${outcome.text}`;
  } else tail = (follow ?? outcome)?.text ?? '';
  const text = `Recomendé ${r.headline.trim().replace(/\.$/, '')}: ${tail}.`.replace(/\s+/g, ' ');
  const facts: PulseFact[] = [...(follow?.facts ?? []), ...(outcome?.facts ?? [])].map((f) => ({
    key: `seguimiento.${index}.${f.suffix}`,
    label: `${f.label} (${r.headline})`,
    value: f.value,
    display: f.display,
  }));
  return { id: r.id, text, facts };
}

/** Qué pasadas se cuentan primero: lo que tuvo desenlace, después lo seguido, después lo ignorado. */
function weight(r: RecommendationRecord): number {
  if (r.outcome === 'good') return 0;
  if (r.status === 'followed') return 1;
  if (r.status === 'in_progress') return 2;
  if (r.status === 'not_followed') return r.severity === 'critical' ? 2 : 3;
  return 4;
}

/**
 * Las frases de la sección, como mucho `max`. Sólo recomendaciones de antes de
 * esta semana (la de hoy todavía no tiene historia).
 */
export function followUpSection(
  records: readonly RecommendationRecord[],
  opts: { today: string; max?: number },
): { lines: string[]; facts: PulseFact[]; ids: string[] } {
  const sorted = [...records].sort(
    (a, b) =>
      weight(a) - weight(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const lines: string[] = [];
  const facts: PulseFact[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of sorted) {
    if (lines.length >= (opts.max ?? 4)) break;
    const key = `${r.kind}:${r.subjectKey}`;
    if (seen.has(key)) continue;
    const s = followUpSentence(r, opts.today, lines.length);
    if (!s) continue;
    seen.add(key);
    lines.push(s.text);
    facts.push(...s.facts);
    ids.push(r.id);
  }
  return { lines, facts, ids };
}

/** El encabezado de la sección, el mismo en la vista y en la conversación. */
export const FOLLOW_UP_HEADING = 'Lo que recomendé y qué pasó';
