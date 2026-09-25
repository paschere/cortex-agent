import { button, calloutBox, fineprint, keyValueTable, lede, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';
import type { Tone } from './theme';

/**
 * El correo del seguimiento de Gerencia (0158).
 *
 * Tres destinatarios con tres preguntas distintas en la cabeza:
 *
 *   owner       «¿Qué me toca?» — el asunto, por qué aparece hoy y el próximo
 *               paso que la propia empresa escribió. Nada más.
 *   escalation  «¿Por qué me llega a mí?» — lo primero que lee es quién es el
 *               responsable y desde cuándo se le avisó sin respuesta. Sin eso,
 *               un escalado parece un error de destinatario.
 *   unowned     «¿Qué hago?» — asignarlo. No hay a quién más perseguir.
 *
 * Español de Colombia, tuteo, frases escritas con reglas y no por un modelo.
 */

export type ManagementFollowUpStep = 'owner' | 'escalation' | 'unowned';

export interface ManagementFollowUpEmailInput {
  step: ManagementFollowUpStep;
  caseId: string;
  title: string;
  nextAction: string;
  blocker: string;
  dueOn: string;
  nextReviewOn: string;
  /** Frases ya redactadas por `followUpReasonText`. */
  reasons: string[];
  ownerName: string | null;
  /** Sólo en el escalado: día del primer aviso al responsable. */
  firstNoticeOn: string | null;
}

const VOICE: Record<
  ManagementFollowUpStep,
  { eyebrow: string; pill: string; tone: Tone; subject: string }
> = {
  owner: {
    eyebrow: 'Seguimiento de Gerencia',
    pill: 'Te toca',
    tone: 'warn',
    subject: 'Te toca mover',
  },
  escalation: {
    eyebrow: 'Escalado de Gerencia',
    pill: 'Sin respuesta',
    tone: 'danger',
    subject: 'Escalado, sin avance',
  },
  unowned: {
    eyebrow: 'Asunto sin responsable',
    pill: 'Sin asignar',
    tone: 'warn',
    subject: 'Falta responsable',
  },
};

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
function spanishDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} de ${MONTHS[Number(m) - 1] ?? m} de ${y}`;
}

function opening(input: ManagementFollowUpEmailInput): string {
  switch (input.step) {
    case 'owner':
      return `Eres responsable de «${input.title}» y hoy necesita que lo muevas: registra el avance, ajusta la próxima revisión o explica qué te bloquea.`;
    case 'escalation':
      return `«${input.title}» está a cargo de ${input.ownerName ?? 'su responsable'}, que recibió un aviso el ${spanishDate(input.firstNoticeOn ?? input.nextReviewOn)} y desde entonces el asunto no ha cambiado. Te llega porque eres a quien se escala.`;
    case 'unowned':
      return `«${input.title}» no tiene responsable. Mientras nadie lo tenga, Cortex no tiene a quién hacerle seguimiento. Asígnalo desde Gerencia.`;
  }
}

export function renderManagementFollowUpEmail(input: ManagementFollowUpEmailInput): RenderedEmail {
  const voice = VOICE[input.step];
  const base = appBaseUrl();
  const url = base ? `${base}/management?case=${encodeURIComponent(input.caseId)}` : '';
  const rows = [
    { label: 'Próximo paso', value: input.nextAction },
    input.blocker ? { label: 'Bloqueo', value: input.blocker } : null,
    { label: 'Plazo', value: spanishDate(input.dueOn) },
    { label: 'Revisión', value: spanishDate(input.nextReviewOn) },
    { label: 'Responsable', value: input.ownerName ?? 'Sin asignar' },
  ].filter(Boolean) as Array<{ label: string; value: string }>;
  const why = input.reasons.join(' ');

  const html = renderEmail({
    title: input.title,
    preheader: why.slice(0, 160),
    eyebrow: voice.eyebrow,
    pillHtml: statusPill({ label: voice.pill, tone: voice.tone }),
    bodyHtml: [
      lede(opening(input)),
      calloutBox({ tone: voice.tone, title: 'Por qué aparece hoy', text: why }),
      keyValueTable(rows),
      url ? button({ href: url, label: 'Abrir el asunto' }) : '',
      fineprint(
        input.step === 'owner'
          ? 'Si en dos días hábiles el asunto no cambia, Cortex lo escala. Cualquier avance guardado detiene el escalado.'
          : 'Cortex solo avisa; no cambia el asunto ni actúa en nombre de nadie.',
      ),
    ]
      .filter(Boolean)
      .join(''),
    footerNote:
      'Cortex hace seguimiento a los asuntos de Gerencia de tu empresa. Un administrador puede apagarlo en Gerencia → Configuración.',
  });

  const text = [
    `${voice.eyebrow.toUpperCase()} — ${input.title}`,
    '',
    opening(input),
    '',
    `Por qué aparece hoy: ${why}`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    url ? `\nAbrir el asunto: ${url}` : '',
  ].join('\n');

  return { subject: `${voice.subject}: ${input.title}`.slice(0, 200), html, text };
}
