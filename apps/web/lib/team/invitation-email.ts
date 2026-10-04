import {
  type RenderedEmail,
  button,
  calloutBox,
  fineprint,
  keyValueTable,
  lede,
  renderEmail,
  statusPill,
} from '../email-templates';
import {
  INVITATION_TTL_DAYS,
  expiryDate,
  invitationRoleBlurb,
  invitationRoleLabel,
} from './invitation-roles';

/**
 * EL CORREO DE INVITACIÓN, EN ESPAÑOL Y CON MARCA.
 *
 * Antes era una línea en inglés («You've been invited to X on Cortex») con un
 * enlace desnudo: lo primero que ve alguien de Cortex, y llegaba como un correo
 * de sistema. Quien lo recibe casi nunca sabe qué es Cortex, así que dice, en
 * este orden: quién lo invitó y a qué empresa, qué es Cortex en una línea, con
 * qué rol entra (en palabras, no `admin`), el botón, y cuándo vence el enlace.
 *
 * El mensaje personal de quien invita va en un recuadro propio y SIEMPRE
 * escapado: es texto escrito por una persona y llega a un correo HTML. Por eso
 * pasa por `calloutBox({ text })`, que lo escapa, y nunca por `html`.
 *
 * Sin `server-only` ni base de datos: construye texto. El envío vive en
 * lib/auth.ts (`sendInvitationEmail`), que es quien conoce la URL base.
 */

export interface InvitationEmailInput {
  /** Quién invita: su nombre, o su correo si no tiene nombre. */
  inviterName: string;
  organizationName: string;
  /** `member`, `admin` u `owner` tal como lo guarda better-auth. */
  role: string | null | undefined;
  /** El enlace de aceptación, ya completo. */
  url: string;
  /** Cuándo vence. Si falta se habla de los días de siempre. */
  expiresAt?: string | Date | null;
  /** Nota opcional que escribió quien invita. */
  message?: string | null;
}

const WHAT_IS_CORTEX =
  'Cortex es el gerente de IA de tu empresa: recuerda cómo trabaja, cuida la cartera y la caja y hace lo rutinario con tu aprobación.';

/** Una nota de 600 caracteres ya es una carta; más se corta, con puntos suspensivos. */
const MAX_MESSAGE = 600;

function cleanMessage(message: string | null | undefined): string {
  const text = (message ?? '').replace(/\r\n/g, '\n').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1).trimEnd()}…` : text;
}

/** `lede` interpreta markdown: un nombre con asteriscos no debe romper el negrita. */
function noMarkdown(text: string): string {
  return text.replace(/[*_`[\]]/g, '');
}

export function invitationSubject(inviterName: string, organizationName: string): string {
  return `${inviterName} te invitó a ${organizationName} en Cortex`.slice(0, 200);
}

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const inviter = input.inviterName.trim() || 'Alguien de tu equipo';
  const company = input.organizationName.trim() || 'su empresa';
  const roleLabel = invitationRoleLabel(input.role);
  const roleBlurb = invitationRoleBlurb(input.role);
  const message = cleanMessage(input.message);
  const until = input.expiresAt ? expiryDate(input.expiresAt) : '';
  const expiry = until
    ? `El enlace vence el ${until} (hora de Colombia).`
    : `El enlace dura ${INVITATION_TTL_DAYS} días.`;
  const subject = invitationSubject(inviter, company);

  const body = [
    lede(
      `**${noMarkdown(inviter)}** te invitó a unirte a **${noMarkdown(company)}** en Cortex. ${WHAT_IS_CORTEX}`,
    ),
    message ? calloutBox({ tone: 'info', title: `Un mensaje de ${inviter}`, text: message }) : '',
    keyValueTable([
      { label: 'Empresa', value: company },
      { label: 'Tu rol', value: `${roleLabel}. ${roleBlurb}` },
    ]),
    button({ href: input.url, label: 'Aceptar la invitación' }),
    fineprint(
      `${expiry} Si todavía no tienes cuenta, el botón te lleva a crearla con este mismo correo y entras directo a ${company}.`,
    ),
    fineprint(
      `Si no esperabas esta invitación, ignora el correo: sin tu aceptación no pasa nada. Si el botón no funciona, copia este enlace en el navegador: ${input.url}`,
    ),
  ];

  const html = renderEmail({
    title: `${inviter} te invitó a ${company}`,
    preheader: `Entras como ${roleLabel.toLowerCase()}. Acepta con un clic. ${expiry}`,
    eyebrow: 'Invitación',
    pillHtml: statusPill({ label: roleLabel, tone: 'info' }),
    bodyHtml: body.filter(Boolean).join(''),
    footerNote: `Recibes este correo porque ${inviter} escribió tu dirección al invitarte a ${company}.`,
    locale: 'es',
  });

  const text = [
    `${inviter} te invitó a unirte a ${company} en Cortex.`,
    '',
    WHAT_IS_CORTEX,
    ...(message ? ['', `Mensaje de ${inviter}:`, message] : []),
    '',
    `Tu rol: ${roleLabel}. ${roleBlurb}`,
    '',
    'Acepta la invitación aquí:',
    input.url,
    '',
    `${expiry} Si todavía no tienes cuenta, el enlace te lleva a crearla con este mismo correo.`,
    '',
    'Si no esperabas esta invitación, ignora este correo: sin tu aceptación no pasa nada.',
  ].join('\n');

  return { subject, html, text };
}
