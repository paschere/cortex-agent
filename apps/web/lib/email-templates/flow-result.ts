import { calloutBox, fineprint, lede, statRow, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';
import { clampMarkdown, markdownToEmailHtml } from './markdown';
import { escapeHtml } from './theme';

/**
 * «Tu trámite corrió» — el resultado, o la noticia de que no salió.
 *
 * ---------------------------------------------------------------------------
 * THE SUBJECT LINE IS THE WHOLE EMAIL
 * ---------------------------------------------------------------------------
 * Most of these are read on a phone, in a notification, without being opened.
 * So the subject says the THING and not the mechanism: «Certificado de
 * tradición · listo», never «browser.run_flow completed». That is exactly why
 * the trámite declares `output_label` — a subject built from a slug and a
 * duration is a subject nobody learns to read.
 *
 * A failure says so first and says what happened second, because the person
 * reading it has to decide whether to go do the errand by hand this morning.
 */

const MAX_RESULT_CHARS = 6_000;

export type FlowOutputKind = 'document' | 'data' | 'confirmation';

export interface FlowResultEmailInput {
  flowId: string;
  flowName: string;
  /** The portal it ran against: `runt.gov.co`. */
  site: string;
  ok: boolean;
  outputKind: FlowOutputKind;
  /** What the thing is called, in the person's words. May be empty. */
  outputLabel: string;
  /** What it came back with, as markdown. Empty for a bare confirmation. */
  resultMarkdown: string;
  errorMessage?: string | null;
  ranAt: Date;
  durationMs?: number | null;
}

function moment(date: Date): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Bogota',
    }).format(date);
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(ms, 1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`.replace('.', ',');
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** Cómo se nombra lo que produjo, para el asunto y la primera línea. */
function thing(input: FlowResultEmailInput): string {
  const label = input.outputLabel.trim();
  if (label) return label;
  return input.outputKind === 'document'
    ? 'El documento'
    : input.outputKind === 'data'
      ? 'El dato'
      : input.flowName;
}

export function renderFlowResultEmail(input: FlowResultEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const what = thing(input);
  const subject = input.ok ? `${what} · listo` : `${what} · no salió`;

  const errorText = (input.errorMessage ?? '').trim() || 'No quedó dicho qué pasó.';
  const clamped = clampMarkdown(input.resultMarkdown ?? '', MAX_RESULT_CHARS);

  const stats = [
    { label: 'Trámite', value: input.flowName },
    { label: 'Portal', value: input.site },
    { label: 'Corrió', value: moment(input.ranAt) },
    {
      label: 'Tardó',
      value: typeof input.durationMs === 'number' ? duration(input.durationMs) : '—',
    },
  ];

  const opener = input.ok
    ? input.outputKind === 'confirmation'
      ? `${what} se hizo en ${input.site}.`
      : `${what} salió de ${input.site}.`
    : `${what} no salió. El trámite se corrió en ${input.site} y se quedó en el camino.`;

  const body = input.ok
    ? [
        lede(opener),
        statRow(stats),
        clamped.markdown.trim() ? markdownToEmailHtml(clamped.markdown) : '',
        clamped.truncated
          ? fineprint('El resultado venía largo y quedó recortado. Completo, en Cortex.')
          : '',
        input.outputKind === 'document'
          ? fineprint(
              'El archivo no viaja en este correo: queda en Cortex, con la corrida que lo produjo.',
            )
          : '',
      ]
    : [
        lede(opener),
        calloutBox({ title: 'Qué pasó', html: `<p style="margin:0">${escapeHtml(errorText)}</p>`, tone: 'danger' }),
        statRow(stats),
        fineprint(
          'Si hoy hace falta, toca hacerlo a mano. En la pantalla del trámite queda el paso exacto en el que se quedó.',
        ),
      ];

  const html = renderEmail({
    title: what,
    preheader: input.ok ? opener : `No salió: ${errorText}`,
    eyebrow: 'Trámite',
    pillHtml: statusPill({ label: input.ok ? 'Listo' : 'No salió', tone: input.ok ? 'success' : 'danger' }),
    bodyHtml: body.filter(Boolean).join('\n'),
    footerNote: base ? `Lo puedes revisar en ${base}/browser` : undefined,
  });

  const text = [
    opener,
    '',
    `Trámite: ${input.flowName}`,
    `Portal: ${input.site}`,
    `Corrió: ${moment(input.ranAt)}`,
    input.ok ? clamped.markdown.trim() : `Qué pasó: ${errorText}`,
    '',
    base ? `${base}/browser` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}
