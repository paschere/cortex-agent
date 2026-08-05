import { button, calloutBox, fineprint, keyValueTable, lede, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';
import type { Tone } from './theme';

/**
 * "Esto se te vence" — the mail the watcher sends.
 *
 * THE SOURCE IS IN THE EMAIL, not just on the screen. This message arrives
 * unprompted and asks somebody to go and do something; the first question a
 * reasonable person has is "¿y esto de dónde salió?". Answering it in the body
 * — the registry and when it was read, or the document and the sentence — is
 * what makes an automated nag credible instead of another system shouting.
 *
 * Four wordings for four moments, because "vence en 30 días" and "venció hace
 * una semana y nadie hizo nada" are not the same message at different
 * intensities. The escalation one in particular is addressed to somebody who
 * did NOT own this and has to understand instantly why it landed on them.
 *
 * Spanish (Colombia), tuteo, sentence case, like everything a person reads.
 */

export type CommitmentNoticeKind = 'ahead' | 'due_today' | 'overdue' | 'escalation';

export interface CommitmentNoticeEmailInput {
  commitment: {
    id: string;
    title: string;
    kindLabel: string;
    dueOn: string;
    daysLeft: number;
    counterparty: string | null;
    amountCop: number | null;
    owner: string | null;
    vehiclePlate: string | null;
    source: {
      kind: 'manual' | 'system' | 'document';
      label: string;
      readAt: string | null;
      quote: string | null;
      confirmed: boolean;
    };
  };
  noticeKind: CommitmentNoticeKind;
  /** The Bogotá calendar day the notice is for. */
  today: string;
}

function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')} COP`;
}

function spanishDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = [
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
  const month = months[Number(m) - 1] ?? m;
  return `${Number(d)} de ${month} de ${y}`;
}

function whenPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'hoy';
  if (daysLeft === 1) return 'mañana';
  if (daysLeft > 0) return `en ${daysLeft} días`;
  if (daysLeft === -1) return 'ayer';
  return `hace ${-daysLeft} días`;
}

const VOICE: Record<
  CommitmentNoticeKind,
  { eyebrow: string; pill: string; tone: Tone; subjectPrefix: string }
> = {
  ahead: {
    eyebrow: 'Aviso anticipado',
    pill: 'Por vencer',
    tone: 'warn',
    subjectPrefix: 'Se vence',
  },
  due_today: { eyebrow: 'Vence hoy', pill: 'Hoy', tone: 'warn', subjectPrefix: 'Vence hoy' },
  overdue: { eyebrow: 'Vencido', pill: 'Vencido', tone: 'danger', subjectPrefix: 'Vencido' },
  escalation: {
    eyebrow: 'Escalado',
    pill: 'Escalado',
    tone: 'danger',
    subjectPrefix: 'Escalado, nadie ha respondido',
  },
};

/** The one sentence that says where the date came from. */
function sourceLine(source: CommitmentNoticeEmailInput['commitment']['source']): string {
  const when = source.readAt ? ` el ${source.readAt.slice(0, 10)}` : '';
  switch (source.kind) {
    case 'system':
      return `Esta fecha la reporta ${source.label}, leída${when}. Cortex no la calculó.`;
    case 'document':
      return `Esta fecha salió de ${source.label}: «${source.quote ?? ''}», y alguien de tu equipo la confirmó.`;
    default:
      return `Esta fecha la registró ${source.label}${when}.`;
  }
}

function opening(input: CommitmentNoticeEmailInput): string {
  const { commitment: c, noticeKind } = input;
  const fecha = spanishDate(c.dueOn);
  switch (noticeKind) {
    case 'ahead':
      return `${c.title} se vence el ${fecha}, ${whenPhrase(c.daysLeft)}. Te aviso ahora para que dé tiempo de moverlo.`;
    case 'due_today':
      return `${c.title} se vence hoy, ${fecha}. Si ya se resolvió, márcalo como cumplido para que deje de aparecer.`;
    case 'overdue':
      return `${c.title} se venció el ${fecha}, ${whenPhrase(c.daysLeft)}, y sigue abierto.`;
    case 'escalation':
      return `${c.title} se venció el ${fecha} y nadie lo ha atendido${
        c.owner ? `; el responsable es ${c.owner}` : ' y no tiene responsable asignado'
      }. Te llega a ti porque el plazo de escalamiento ya pasó.`;
  }
}

export function renderCommitmentNoticeEmail(input: CommitmentNoticeEmailInput): RenderedEmail {
  const { commitment: c, noticeKind } = input;
  const voice = VOICE[noticeKind];
  const base = appBaseUrl();
  const detailUrl = base ? `${base}/commitments/${c.id}` : '';

  const rows = [
    { label: 'Vence', value: spanishDate(c.dueOn) },
    { label: 'Tipo', value: c.kindLabel },
    c.counterparty ? { label: 'Con', value: c.counterparty } : null,
    c.vehiclePlate ? { label: 'Vehículo', value: c.vehiclePlate } : null,
    c.amountCop ? { label: 'Valor', value: cop(c.amountCop) } : null,
    { label: 'Responsable', value: c.owner ?? 'Sin asignar' },
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  const bodyHtml = [
    lede(opening(input)),
    keyValueTable(rows),
    calloutBox({
      tone: noticeKind === 'ahead' ? 'info' : voice.tone,
      title: 'De dónde sale esta fecha',
      text: sourceLine(c.source),
    }),
    detailUrl ? button({ href: detailUrl, label: 'Ver en Cortex' }) : '',
    fineprint(
      'Este aviso sale una sola vez por vencimiento. Si ya lo atendiste, márcalo en Cortex y no se vuelve a mencionar.',
    ),
  ]
    .filter(Boolean)
    .join('');

  const html = renderEmail({
    title: c.title,
    preheader: `${voice.subjectPrefix} el ${spanishDate(c.dueOn)} · ${sourceLine(c.source)}`.slice(
      0,
      160,
    ),
    eyebrow: voice.eyebrow,
    pillHtml: statusPill({ label: voice.pill, tone: voice.tone }),
    bodyHtml,
    footerNote:
      'Cortex vigila los vencimientos de tu empresa y avisa antes de que pasen. Este correo salió solo.',
  });

  const text = [
    `${voice.eyebrow.toUpperCase()} — ${c.title}`,
    '',
    opening(input),
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    sourceLine(c.source),
    detailUrl ? `\nVer en Cortex: ${detailUrl}` : '',
    '',
    'Este aviso sale una sola vez por vencimiento.',
  ].join('\n');

  return {
    subject: `${voice.subjectPrefix}: ${c.title} (${spanishDate(c.dueOn)})`,
    html,
    text,
  };
}
