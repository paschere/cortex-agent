import { button, fineprint, keyValueTable, lede } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * «Tu día» por correo (0220): las mismas frases de la campana, sin botones de
 * un clic — el correo lleva un ENLACE a la pantalla donde se decide (el piloto
 * o los compromisos), nunca una acción que se ejecuta al abrirlo. Español de
 * Colombia, tuteo, escrito por reglas.
 */

export interface BriefingEmailInput {
  title: string;
  bullets: string[];
  /** Ruta interna a la que lleva el botón. */
  href: string;
  scope: 'company' | 'person';
}

export function renderBriefingEmail(input: BriefingEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const url = base ? `${base}${input.href}` : '';
  const opening =
    input.scope === 'company'
      ? 'Esto es lo que vale la pena mirar hoy en la empresa.'
      : 'Esto es lo tuyo que vale la pena mirar hoy.';
  const html = renderEmail({
    title: input.title,
    preheader: (input.bullets[0] ?? opening).slice(0, 140),
    eyebrow: 'Tu día',
    locale: 'es',
    bodyHtml: [
      lede(opening),
      keyValueTable(input.bullets.map((b, i) => ({ label: String(i + 1), value: b }))),
      url
        ? button({
            href: url,
            label: input.scope === 'company' ? 'Abrir el piloto' : 'Abrir mis pendientes',
          })
        : '',
      fineprint('Lo que se puede hacer con un clic lo encuentras en tus avisos, dentro de Cortex.'),
    ]
      .filter(Boolean)
      .join(''),
    footerNote: 'Cortex te escribe cada mañana hábil sólo si hay algo que contarte.',
  });
  const text = [
    input.title,
    '',
    opening,
    '',
    ...input.bullets.map((b) => `- ${b}`),
    url ? `\nAbrir: ${url}` : '',
  ].join('\n');
  return { subject: input.title.slice(0, 200), html, text };
}
