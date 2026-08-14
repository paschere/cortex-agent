import {
  type RenderedEmail,
  appBaseUrl,
  button,
  calloutBox,
  fineprint,
  keyValueTable,
  lede,
  renderEmail,
  statRow,
  statusPill,
} from '@/lib/email-templates';
import {
  type Cadence,
  type GoalReadingRow,
  type GoalRow,
  type NoticeClass,
  describeTarget,
  formatGoalValue,
} from '@cortex/agent-tools';

/**
 * El correo que manda una meta cuando el período cierra del lado que no toca —
 * y el que manda cuando vuelve a su sitio.
 *
 * ===========================================================================
 * POR QUÉ EL MÉTODO VA EN EL CORREO Y NO SÓLO EN LA PANTALLA
 * ===========================================================================
 * Un correo que dice «la cartera se te fue a 52 días» y nada más provoca dos
 * reacciones y las dos son malas: creérselo sin mirar, o no creérselo y dejar
 * de abrir los siguientes. La frase que dice CÓMO se calculó —cuántas facturas,
 * en qué moneda, qué se quedó fuera— es lo que convierte el aviso en algo que
 * se puede comprobar en cinco minutos, y comprobarlo una vez es lo que hace que
 * el segundo aviso se lea.
 *
 * ===========================================================================
 * POR QUÉ HAY UN CORREO DE RECUPERACIÓN
 * ===========================================================================
 * Quien sólo escribe cuando algo se rompe enseña a temer sus correos, y de ahí
 * a filtrarlos hay un paso. El de recuperación cuesta casi nada y es la mitad
 * del trabajo de un gerente: decir también cuándo se arregló, con el número
 * delante, para que quien lo arregló lo vea escrito.
 *
 * Sin `server-only` y sin base de datos: construye texto, como el resto de
 * `lib/email-templates`.
 */

const CADENCE_WORD: Record<Cadence, string> = {
  week: 'semanal',
  month: 'mensual',
};

export interface GoalNoticeEmailInput {
  goal: GoalRow;
  reading: GoalReadingRow;
  noticeClass: NoticeClass;
  /** Cómo se llama el período: «julio de 2026». */
  periodLabel: string;
  /** El estado del último período medible anterior, para el contraste. */
  previousDisplay?: string | null;
}

export function renderGoalNoticeEmail(input: GoalNoticeEmailInput): RenderedEmail {
  const { goal, reading, noticeClass } = input;
  const breached = noticeClass === 'breached';
  const objetivo = describeTarget(goal.direction, goal.target_value, goal.unit);
  const distancia = distanceSentence(reading, goal);

  const subject = breached
    ? `${goal.label}: ${reading.display} en ${input.periodLabel} (objetivo: ${objetivo})`
    : `${goal.label} volvió a su sitio: ${reading.display} en ${input.periodLabel}`;

  const preheader = breached
    ? `${distancia} La cifra está calculada sobre ${reading.sample_size} dato(s); abajo va cómo se hizo la cuenta.`
    : `Después de un período fuera de rango, ${input.periodLabel} cerró cumpliendo. Aquí va el número y de dónde sale.`;

  const base = appBaseUrl();

  const bodyHtml = [
    lede(
      breached
        ? `${input.periodLabel} cerró en ${reading.display} y la meta ${CADENCE_WORD[goal.cadence]} es ${objetivo}. ${distancia}`
        : `${input.periodLabel} cerró en ${reading.display}, dentro de la meta ${CADENCE_WORD[goal.cadence]} de ${objetivo}. El período medible anterior no cumplía.`,
    ),
    statRow([
      { label: input.periodLabel, value: reading.display },
      { label: 'Objetivo', value: formatGoalValue(goal.target_value, goal.unit) },
      {
        label: 'Período anterior',
        value: input.previousDisplay ?? '—',
      },
      { label: 'Sobre', value: `${reading.sample_size} dato(s)` },
    ]),
    // LA FRASE DEL MÉTODO, ENTERA Y SIN RECORTAR. Es lo que se puede rehacer a
    // mano, y es la razón por la que este correo se puede discutir en vez de
    // sólo creer o ignorar.
    calloutBox({
      tone: 'neutral',
      title: 'Cómo se calculó',
      text: reading.method,
    }),
    keyValueTable([
      { label: 'Meta', value: goal.label },
      { label: 'Periodicidad', value: CADENCE_WORD[goal.cadence] },
      { label: 'Fijada por', value: goal.created_by_name ?? 'alguien de este espacio' },
      { label: 'Período', value: `${reading.period_start} a ${reading.period_end}` },
    ]),
    base ? button({ href: `${base}/goals`, label: 'Ver la meta y su histórico' }) : '',
    fineprint(
      'Esta lectura quedó congelada tal cual: si mañana cambia el objetivo, este período seguirá diciendo contra qué se juzgó hoy.',
    ),
  ]
    .filter(Boolean)
    .join('');

  const html = renderEmail({
    title: breached ? `${goal.label} se salió de la meta` : `${goal.label} volvió a la meta`,
    preheader,
    eyebrow: breached ? 'Meta incumplida' : 'Meta recuperada',
    pillHtml: statusPill({
      label: breached ? 'Fuera de meta' : 'De vuelta',
      tone: breached ? 'danger' : 'success',
    }),
    bodyHtml,
    footerNote:
      'Recibes esto porque fijaste esta meta en Cortex, o porque administras este espacio de trabajo.',
  });

  const text = [
    subject,
    '',
    breached
      ? `${input.periodLabel} cerró en ${reading.display}. La meta ${CADENCE_WORD[goal.cadence]} es ${objetivo}.`
      : `${input.periodLabel} cerró en ${reading.display}, dentro de la meta de ${objetivo}.`,
    input.previousDisplay ? `Período medible anterior: ${input.previousDisplay}.` : '',
    '',
    'Cómo se calculó:',
    reading.method,
    '',
    `Período: ${reading.period_start} a ${reading.period_end}. Sobre ${reading.sample_size} dato(s).`,
    base ? `${base}/goals` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

/**
 * Cuánto se pasó, en las unidades de la meta.
 *
 * Se dice la DISTANCIA y no un porcentaje de desviación: «once días por encima»
 * es una frase sobre la que alguien puede actuar; «un 24% por encima del
 * objetivo» hay que traducirla mentalmente antes de significar algo.
 */
function distanceSentence(reading: GoalReadingRow, goal: GoalRow): string {
  if (reading.value == null) return '';
  const gap = Math.abs(reading.value - goal.target_value);
  if (gap === 0) return 'Está justo en el límite.';
  const side = goal.direction === 'lower_is_better' ? 'por encima' : 'por debajo';
  return `Son ${formatGoalValue(gap, goal.unit)} ${side} de lo fijado.`;
}
