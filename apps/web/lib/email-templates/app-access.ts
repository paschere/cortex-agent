import { button, codeBlock, fineprint, lede, statusPill } from './components';
import { type EmailBrand, type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * Los dos correos de la entrada a una aplicación (0209): el CÓDIGO de 6
 * dígitos y la INVITACIÓN con el enlace a /a/<app>. Español de Colombia,
 * tuteo, sin nombrar ningún negocio: sirven para cualquier empresa.
 */

export function appEntryUrl(appId: string): string {
  const base = appBaseUrl();
  return base ? `${base}/a/${encodeURIComponent(appId)}` : '';
}

export interface AppLoginCodeEmailInput {
  appName: string;
  code: string;
  minutes: number;
  /** La marca de la app (0215); sin ella, el encabezado de Cortex. */
  brand?: EmailBrand;
}

export function renderAppLoginCodeEmail(input: AppLoginCodeEmailInput): RenderedEmail {
  const title = `Tu código para entrar a ${input.appName}`.slice(0, 200);
  const opening = `Escribe este código en la pantalla de entrada de «${input.appName}». Vence en ${input.minutes} minutos.`;
  const html = renderEmail({
    title,
    preheader: `Tu código es ${input.code}. Vence en ${input.minutes} minutos.`,
    eyebrow: 'Entrar',
    pillHtml: statusPill({ label: `${input.minutes} min`, tone: 'info' }),
    bodyHtml: [
      lede(opening),
      codeBlock(input.code, { label: 'Tu código' }),
      fineprint(
        'Si no fuiste tú quien pidió entrar, ignora este correo: sin el código nadie puede entrar a tu cuenta. No lo compartas con nadie.',
      ),
    ].join(''),
    footerNote: 'Este código sirve una sola vez.',
    locale: 'es',
    brand: input.brand,
  });
  const text = [
    title,
    '',
    opening,
    '',
    `Tu código: ${input.code}`,
    '',
    'Si no fuiste tú, ignora este correo.',
  ].join('\n');
  return { subject: title, html, text };
}

export interface AppInvitationEmailInput {
  appId: string;
  appName: string;
  organizationName: string;
  name: string;
  roleName: string;
  brand?: EmailBrand;
}

export function renderAppInvitationEmail(input: AppInvitationEmailInput): RenderedEmail {
  const url = appEntryUrl(input.appId);
  const title = `${input.organizationName} te invitó a ${input.appName}`.slice(0, 200);
  const opening = `Hola ${input.name}, ${input.organizationName} te dio acceso a «${input.appName}» como ${input.roleName}. No necesitas crear una cuenta: abre el enlace, escribe este correo y te llega un código para entrar.`;
  const html = renderEmail({
    title,
    preheader: opening.slice(0, 140),
    eyebrow: 'Invitación',
    pillHtml: statusPill({ label: input.roleName, tone: 'info' }),
    bodyHtml: [
      lede(opening),
      url
        ? button({
            href: url,
            label: `Abrir ${input.appName}`,
            color: input.brand && { bg: input.brand.buttonColor, ink: input.brand.buttonInk },
          })
        : '',
      fineprint(
        'Desde el celular puedes instalarla como una app (botón «Instalar en este teléfono» dentro de la pantalla).',
      ),
    ]
      .filter(Boolean)
      .join(''),
    footerNote: 'Si no esperabas esta invitación, ignora este correo.',
    locale: 'es',
    brand: input.brand,
  });
  const text = [title, '', opening, url ? `\nAbrir la app: ${url}` : ''].join('\n');
  return { subject: title, html, text };
}
