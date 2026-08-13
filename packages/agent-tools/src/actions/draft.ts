import {
  KIND_LABEL as COMMITMENT_KIND_LABEL,
  type CommitmentRow,
  cop,
  daysUntilDue,
  describeSource,
  plural,
  sourceSentence,
} from '../commitments/shape';

/**
 * «Mandar el informe» rather than «Mandar el informe», mid-sentence.
 *
 * Titles are written as headings — capitalised — and this one gets embedded in
 * «Quedaste de …». Only the first letter is touched, so «Informe SOAT de
 * agosto» keeps its acronym.
 */
function lowerFirst(text: string): string {
  const t = text.trim();
  return t ? t[0]?.toLowerCase() + t.slice(1) : t;
}

/**
 * The house wording, as pure functions of a commitment row.
 *
 * WHY TEMPLATES AND NOT THE MODEL. Every figure in a cobro is a claim about
 * money: an amount, a date, a number of days late. A model asked to write the
 * same email from the same row will get those right almost every time, and
 * "almost" is not a standard you can send to a client over somebody's own
 * signature. These functions read the numbers off the row, so the sentence
 * "lleva 47 días vencida" is true because 47 was computed, not because it was
 * remembered.
 *
 * The model is still the author when it is the one with the context — an answer
 * to a specific email, a cobro that needs to mention last week's call. It hands
 * its own `body` to `actions.propose` and this file is not involved. What these
 * templates guarantee is the FLOOR: the version Cortex writes with nobody
 * watching never invents a figure.
 *
 * REGISTER. A client is addressed as *usted*, a colleague as *tú*. That is not
 * decoration — a cobro written in tuteo reads as either a friend or a mistake,
 * and neither is what you want the first time you chase an invoice.
 */

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

/**
 * `2026-09-12` → `12 de septiembre de 2026`.
 *
 * Split by hand rather than through Intl: `due_on` is a calendar date with no
 * instant attached, and every route through Date() invites a timezone to shift
 * it by one — which on this screen means telling somebody a deadline is a day
 * earlier than it is. See the note on bogotaToday() in commitments/shape.ts.
 */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!y || !month || !d) return isoDate;
  return `${Number(d)} de ${month} de ${y}`;
}

/** `2026-09-12` → `12 sep`, for a subject line that has to stay short. */
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!month || !d) return isoDate;
  return `${Number(d)} ${month.slice(0, 3)}`;
}

export interface Draft {
  subject: string;
  body: string;
  /** One sentence naming the fact this came out of. Shown under the draft. */
  rationale: string;
}

/**
 * The cobro. Client-facing, *usted*, and deliberately short.
 *
 * A first cobro is not a legal notice and should not read like one: it states
 * the fact, asks for a date, and offers to look at the invoice if something is
 * wrong with it. The last part matters commercially — a good share of "no han
 * pagado" turns out to be "la factura llegó con el NIT malo", and an email that
 * makes that easy to say gets answered.
 */
export function draftCollectionNotice(
  row: Pick<CommitmentRow, 'title' | 'counterparty' | 'amount_cop' | 'due_on'> &
    Partial<CommitmentRow>,
  today: string,
): Draft {
  const late = -daysUntilDue(row.due_on, today);
  const who = row.counterparty?.trim() || row.title;
  const amount = row.amount_cop ? cop(row.amount_cop) : null;

  const subject = amount
    ? `Cartera pendiente — ${row.title} por ${amount}`
    : `Cartera pendiente — ${row.title}`;

  const opening = amount
    ? `Nos permitimos recordarle que el pago de ${row.title}, por ${amount}, tenía como fecha límite el ${longDate(row.due_on)}.`
    : `Nos permitimos recordarle que el pago de ${row.title} tenía como fecha límite el ${longDate(row.due_on)}.`;

  const lateness =
    late > 0 ? ` A la fecha lleva ${plural(late, 'día')} de mora.` : ' La fecha ya se cumplió.';

  const body = [
    'Buen día,',
    '',
    `${opening}${lateness}`,
    '',
    'Le agradecemos confirmarnos la fecha en que quedaría realizado el pago. Si hay alguna novedad con la factura, cuéntenos y la revisamos de inmediato.',
    '',
    'Quedamos atentos.',
  ].join('\n');

  return {
    subject,
    body,
    rationale:
      late > 0
        ? `${who} lleva ${plural(late, 'día')} de mora en ${row.title}${amount ? ` (${amount})` : ''}.`
        : `${row.title} de ${who} venció el ${longDate(row.due_on)}.`,
  };
}

/**
 * The deadline, handed back to whoever answers for it. Internal, *tú*.
 *
 * Two flavours out of one function, because they are the same message: a
 * lapsed receivable is a deadline like any other, it just happens to be one
 * whose next step is an email to somebody else. The payment flavour ends by
 * offering exactly that step — which is how a person who reads this at 6am
 * discovers that the cobro is one sentence away rather than one afternoon.
 */
export function draftOwnerReminder(
  row: CommitmentRow,
  today: string,
  ownerFirstName: string | null,
): Draft {
  const left = daysUntilDue(row.due_on, today);
  const label = COMMITMENT_KIND_LABEL[row.kind] ?? 'Compromiso';
  const greeting = ownerFirstName ? `Hola ${ownerFirstName},` : 'Hola,';
  const provenance = sourceSentence(describeSource(row));

  const when =
    left === 0
      ? 'vence hoy'
      : left > 0
        ? `vence en ${plural(left, 'día')}`
        : `está vencido hace ${plural(-left, 'día')}`;

  if (row.kind === 'payment') {
    const who = row.counterparty?.trim() || row.title;
    const amount = row.amount_cop ? cop(row.amount_cop) : null;
    const subject =
      left < 0
        ? `Cartera vencida — ${who} (${plural(-left, 'día')})`
        : `Pago por vencer — ${who} (${shortDate(row.due_on)})`;
    const body = [
      greeting,
      '',
      amount
        ? `${row.title}: ${amount} de ${who}, con fecha ${longDate(row.due_on)} — ${when}.`
        : `${row.title}, de ${who}, con fecha ${longDate(row.due_on)} — ${when}.`,
      '',
      provenance,
      '',
      'Si quieres, te dejo el cobro redactado y listo para enviar: pídemelo en el chat y lo preparo con estos mismos datos. Si ya lo pagaron, márcalo como cumplido en Vencimientos y dejo de insistir.',
    ].join('\n');
    return {
      subject,
      body,
      rationale:
        left < 0
          ? `${who} lleva ${plural(-left, 'día')} de mora en ${row.title}.`
          : `${row.title} de ${who} ${when}.`,
    };
  }

  /**
   * A PROMISE BETWEEN TWO PEOPLE HERE READS NOTHING LIKE A LAPSING SOAT.
   *
   * Without this branch the generic wording below would reach Ana as
   * «Compromiso interno — Informe de agosto por vencer», which is the voice of
   * a filing cabinet talking about a piece of paper. She did not acquire an
   * obligation; she said she would do something. So: her own words back
   * («quedaste de…»), no vehicle, no expiry vocabulary, and the way out named
   * in the same sentence.
   *
   * The provenance line matters more here than anywhere else in this file. A
   * reminder about a SOAT is impersonal; a reminder about a promise is somebody
   * saying "you said you would". `describeSource` on a `manual` row names who
   * wrote it down and when, so the message can be answered — «yo no dije eso»
   * has somewhere to go.
   */
  if (row.kind === 'internal') {
    const subject =
      left < 0
        ? `Quedó pendiente — ${row.title}`
        : left === 0
          ? `Es para hoy — ${row.title}`
          : `Recordatorio — ${row.title}`;
    const body = [
      greeting,
      '',
      `Quedaste de ${lowerFirst(row.title)}, con fecha ${longDate(row.due_on)} — ${when}.`,
      ...(row.detail?.trim() ? ['', row.detail.trim()] : []),
      '',
      provenance,
      '',
      'Si ya está, márcalo como cumplido en Vencimientos y dejo de insistir. Si cambió la fecha o ya no aplica, dímelo y lo ajusto.',
    ].join('\n');
    return {
      subject,
      body,
      rationale:
        left < 0
          ? `${row.title} lleva ${plural(-left, 'día')} sin cerrarse.`
          : `${row.title} ${when}.`,
    };
  }

  const what = row.vehicle_plate
    ? `${label} de la placa ${row.vehicle_plate}`
    : `${label} — ${row.title}`;
  const subject =
    left < 0
      ? `${label} vencido — ${row.vehicle_plate ?? row.title}`
      : `${label} por vencer — ${row.vehicle_plate ?? row.title} (${shortDate(row.due_on)})`;

  const body = [
    greeting,
    '',
    `${what} ${when}: la fecha es el ${longDate(row.due_on)}.`,
    ...(row.detail ? ['', row.detail] : []),
    '',
    provenance,
    '',
    '¿Lo tienes en trámite? Si ya quedó resuelto, márcalo como cumplido en Vencimientos y dejo de insistir.',
  ].join('\n');

  return {
    subject,
    body,
    rationale: `${what} ${when} (${longDate(row.due_on)}).`,
  };
}
