import { button, fineprint, keyValueTable, lede, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * El resumen de lo vencido por correo (0177): UNO por semana, el lunes.
 *
 * La campana lo dice cada mañana hábil; el correo sólo el lunes, para que la
 * semana empiece con la lista y el buzón no reciba lo mismo cinco veces. Habla
 * sólo de lo de quien lo recibe. Español de Colombia, tuteo, con reglas.
 */

export interface WorkOverdueDigestEmailInput {
  title: string;
  count: number;
  lines: Array<{ title: string; daysOverdue: number }>;
}

function overdue(days: number): string {
  return days <= 1 ? 'venció ayer' : `hace ${days} días`;
}

export function renderWorkOverdueDigestEmail(input: WorkOverdueDigestEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const url = base ? `${base}/team/yo` : '';
  const rows = input.lines.map((l) => ({ label: overdue(l.daysOverdue), value: l.title }));
  const more = input.count - input.lines.length;
  const opening =
    'Esto es lo tuyo que está vencido en el registro de trabajo. Ciérralo, ponle fecha nueva o pide ayuda: desde «Mi semana» Cortex te puede redactar el aviso o proponer a quién pasárselo.';

  const html = renderEmail({
    title: input.title,
    preheader: opening.slice(0, 140),
    eyebrow: 'Tu semana',
    pillHtml: statusPill({ label: `${input.count} vencidos`, tone: 'warn' }),
    bodyHtml: [
      lede(opening),
      keyValueTable(rows),
      more > 0 ? fineprint(`Y ${more} más en tu semana.`) : '',
      url ? button({ href: url, label: 'Abrir Mi semana' }) : '',
      fineprint('Sólo ves lo tuyo; nadie más recibe esta lista.'),
    ]
      .filter(Boolean)
      .join(''),
    footerNote:
      'Cortex le recuerda a cada quien lo suyo vencido. Un administrador puede apagarlo en Equipo → Qué se mide.',
  });

  const text = [
    input.title,
    '',
    opening,
    '',
    ...input.lines.map((l) => `- ${l.title} (${overdue(l.daysOverdue)})`),
    more > 0 ? `Y ${more} más.` : '',
    url ? `\nAbrir Mi semana: ${url}` : '',
  ].join('\n');

  return { subject: input.title.slice(0, 200), html, text };
}
