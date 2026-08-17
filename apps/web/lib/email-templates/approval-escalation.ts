import { button, calloutBox, fineprint, keyValueTable, lede, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * «Esto lleva parado y nadie ha contestado» — el correo que sube un escalón.
 *
 * ===========================================================================
 * LO PRIMERO QUE TIENE QUE DECIR ES QUE NO ES PARA APROBARLO
 * ===========================================================================
 * Quien recibe esto NO puede aprobar nada. Aprobar una acción es exclusivo de
 * su dueño porque el correo sale de SU Gmail y va firmado con SU nombre (ver
 * `actions.user_id` en la migración 0077 y `claimAction`). Un correo de
 * escalado que no lo diga en el cuerpo produce exactamente un resultado: el
 * jefe entra a Cortex, busca la acción, no encuentra ningún botón, y concluye
 * que el producto está roto. Así que el texto lo dice, en su propia caja, antes
 * que ninguna otra cosa accionable.
 *
 * Lo que sí puede hacer es lo único que hacía falta y nadie estaba haciendo:
 * ir y mover a su gente.
 *
 * ===========================================================================
 * CORTO, Y CON LA CIFRA DELANTE
 * ===========================================================================
 * Un aviso de escalado que se lee en diez segundos se lee. La primera frase
 * lleva el número de horas y el nombre del dueño, porque son los dos datos con
 * los que se decide si hay que hacer algo hoy; todo lo demás cabe en la tabla.
 *
 * Español (Colombia), tuteo, sentence case, como todo lo que lee una persona.
 */

export interface ApprovalEscalationEmailInput {
  /** Cómo se llama quien recibe esto. Sólo el nombre de pila, o nulo. */
  managerFirstName: string | null;
  /** Quien tiene que aprobarla, con nombre y apellido o su correo. */
  ownerLabel: string;
  /** Qué es: `KIND_LABEL` de la acción. */
  kindLabel: string;
  /** A quién va dirigida la acción parada. */
  recipient: string;
  /** El asunto del correo que saldría si se aprobara. */
  subject: string;
  /** La frase que dice de dónde salió la propuesta. */
  rationale: string;
  /** Horas completas que lleva esperando. */
  hoursWaiting: number;
  /** Cuándo deja de poderse aprobar (ISO). */
  expiresAt: string;
  /**
   * Por qué le llegó a esta persona: 'manager' = es el jefe del dueño,
   * 'admin' = el dueño no tiene jefe puesto y es administrador del espacio.
   */
  via: 'manager' | 'admin';
}

function daysPhrase(hours: number): string {
  if (hours < 48) return `${hours} horas`;
  return `${Math.floor(hours / 24)} días`;
}

/** Cuánto le queda de vida a la propuesta, en días completos hacia abajo. */
function remainingPhrase(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return 'está a punto de vencerse';
  const days = Math.floor(left / 86_400_000);
  if (days <= 0) return 'se vence hoy';
  if (days === 1) return 'se vence mañana';
  return `se vence en ${days} días`;
}

export function renderApprovalEscalationEmail(input: ApprovalEscalationEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const queueUrl = base ? `${base}/actions` : '';
  const espera = daysPhrase(input.hoursWaiting);

  // Por qué le llegó a ESTA persona, en una frase. Sin ella, el escalado por
  // administrador se lee como un correo mandado al azar — que es exactamente lo
  // que era antes de que existiera `users.manager_id` (migración 0106).
  const porQue =
    input.via === 'manager'
      ? `${input.ownerLabel} te responde a ti.`
      : `${input.ownerLabel} no tiene jefe puesto en Cortex y tú eres administrador del espacio.`;
  // El nombre de pila cuando lo hay: un aviso que te nombra se lee como algo
  // que alguien te está diciendo, y no como un renglón de un informe.
  const saludo = input.managerFirstName ? `${input.managerFirstName}: ` : '';
  const opening = `${saludo}${input.kindLabel} a ${input.recipient} lleva ${espera} esperando a que ${input.ownerLabel} la apruebe, y ${remainingPhrase(input.expiresAt)}. Te llega a ti porque ${porQue}`;

  const rows = [
    { label: 'Qué es', value: input.kindLabel },
    { label: 'Para', value: input.recipient },
    { label: 'Asunto', value: input.subject },
    { label: 'Responsable', value: input.ownerLabel },
    { label: 'Esperando', value: espera },
  ];

  // La caja va ANTES del botón, siempre. Ver la cabecera.
  const noYou = calloutBox({
    tone: 'info',
    title: 'Esto no lo apruebas tú',
    text: `El correo sale del Gmail de ${input.ownerLabel} y va firmado con su nombre, así que sólo ${input.ownerLabel} puede aprobarlo. Este aviso es para que sepas que lleva ${espera} sin moverse.`,
  });

  const bodyHtml = [
    lede(opening),
    keyValueTable(rows),
    calloutBox({ tone: 'warn', title: 'De dónde salió', text: input.rationale }),
    noYou,
    queueUrl ? button({ href: queueUrl, label: 'Ver la cola en Cortex', tone: 'quiet' }) : '',
    fineprint(
      'Este aviso sale UNA sola vez por acción, aunque siga sin contestarse. Si ya se resolvió, no tienes que hacer nada.',
    ),
  ]
    .filter(Boolean)
    .join('');

  const html = renderEmail({
    title: `${input.kindLabel} a ${input.recipient}`,
    preheader:
      `Lleva ${espera} esperando a ${input.ownerLabel} y ${remainingPhrase(input.expiresAt)}.`.slice(
        0,
        160,
      ),
    eyebrow: 'Escalado',
    pillHtml: statusPill({ label: 'Sin respuesta', tone: 'warn' }),
    bodyHtml,
    footerNote:
      'Cortex avisa hacia arriba cuando una aprobación lleva demasiado tiempo parada. Este correo salió solo.',
  });

  const text = [
    `ESCALADO — ${input.kindLabel} a ${input.recipient}`,
    '',
    opening,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    `De dónde salió: ${input.rationale}`,
    '',
    `Esto no lo apruebas tú: el correo sale del Gmail de ${input.ownerLabel} y va firmado con su nombre.`,
    queueUrl ? `\nVer la cola en Cortex: ${queueUrl}` : '',
    '',
    'Este aviso sale una sola vez por acción.',
  ].join('\n');

  return {
    subject: `Lleva ${espera} sin aprobarse: ${input.kindLabel.toLowerCase()} a ${input.recipient}`,
    html,
    text,
  };
}
