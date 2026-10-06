import { button, fineprint, keyValueTable, lede, statRow, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * El resumen periódico de una vista (0203): las cifras de sus bloques, lo que
 * entró desde el último envío y las novedades (cambios, duplicados). Español
 * de Colombia, tuteo. Pensado para cualquier empresa: no nombra ninguna tabla
 * ni negocio, sólo lo que la vista tiene.
 */

export interface ViewDigestEmailInput {
  viewName: string;
  viewSlug: string;
  cadence: 'daily' | 'weekly';
  /** «ayer» / «la semana pasada» ya resuelto por quien arma el correo. */
  sinceLabel: string;
  metrics: Array<{ title: string; display: string; goal: string | null; status: string | null }>;
  sources: Array<{
    name: string;
    added: number;
    changed: number;
    flagged: number;
    sample: string[];
  }>;
}

export function renderViewDigestEmail(input: ViewDigestEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const url = base ? `${base}/views/${encodeURIComponent(input.viewSlug)}` : '';
  const kind = input.cadence === 'weekly' ? 'Resumen semanal' : 'Resumen diario';
  const title = `${kind}: ${input.viewName}`.slice(0, 200);
  const added = input.sources.reduce((n, s) => n + s.added, 0);
  const flagged = input.sources.reduce((n, s) => n + s.flagged, 0);
  const opening = `Esto es lo que dice «${input.viewName}» y lo que pasó desde ${input.sinceLabel}.`;

  const metricRows = input.metrics.map((m) => ({
    label: m.title,
    value: [m.display, m.goal ? `meta ${m.goal}` : '', m.status ?? ''].filter(Boolean).join(' · '),
  }));
  const sourceRows = input.sources.map((s) => ({
    label: s.name,
    value: [
      s.added ? `${s.added} ${s.added === 1 ? 'nueva' : 'nuevas'}` : '',
      s.changed ? `${s.changed} ${s.changed === 1 ? 'cambió' : 'cambiaron'}` : '',
      s.flagged ? `${s.flagged} ${s.flagged === 1 ? 'duplicada' : 'duplicadas'}` : '',
      s.sample.length ? `(${s.sample.join(', ')})` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  const html = renderEmail({
    title,
    preheader: opening.slice(0, 140),
    eyebrow: kind,
    pillHtml: flagged
      ? statusPill({ label: `${flagged} por revisar`, tone: 'warn' })
      : statusPill({ label: added ? `${added} nuevas` : 'Sin novedades', tone: 'info' }),
    bodyHtml: [
      lede(opening),
      metricRows.length
        ? statRow(input.metrics.slice(0, 4).map((m) => ({ label: m.title, value: m.display })))
        : '',
      metricRows.length > 4 ? keyValueTable(metricRows.slice(4)) : '',
      sourceRows.length
        ? keyValueTable(sourceRows)
        : fineprint('No hubo filas nuevas ni cambios en este período.'),
      url ? button({ href: url, label: 'Abrir la vista' }) : '',
    ]
      .filter(Boolean)
      .join(''),
    footerNote:
      'Recibes este resumen porque quien administra la vista te eligió. Pídele que te quite de la lista en los ajustes de la vista.',
    locale: 'es',
  });

  const text = [
    title,
    '',
    opening,
    '',
    ...input.metrics.map(
      (m) =>
        `- ${m.title}: ${m.display}${m.goal ? ` (meta ${m.goal})` : ''}${m.status ? ` · ${m.status}` : ''}`,
    ),
    '',
    ...(input.sources.length
      ? input.sources.map(
          (s) => `- ${s.name}: ${sourceRows.find((r) => r.label === s.name)?.value}`,
        )
      : ['No hubo filas nuevas ni cambios en este período.']),
    url ? `\nAbrir la vista: ${url}` : '',
  ].join('\n');

  return { subject: title, html, text };
}
