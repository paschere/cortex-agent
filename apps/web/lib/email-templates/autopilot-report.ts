import { button, calloutBox, fineprint, lede, statRow, statusPill } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';

/**
 * El correo del piloto automático (0176): «Hoy hice 6 cosas; necesito tu
 * decisión en 3». Uno por corrida, al dueño (quien lo encendió).
 *
 * Lo primero que se lee es la frase; debajo, lo que espera decisión (es lo
 * único que le pide algo), y lo hecho en una lista corta. El detalle, con la
 * evidencia y la verificación de cada cosa, está en /piloto.
 */

export interface AutopilotReportEmailInput {
  runId: string;
  day: string;
  message: string;
  done: number;
  asked: number;
  failed: number;
  stillWaiting: number;
  doneTitles: string[];
  askedTitles: string[];
}

export function renderAutopilotReportEmail(input: AutopilotReportEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const url = base ? `${base}/piloto/${encodeURIComponent(input.runId)}` : '';
  const waiting = input.asked + input.stillWaiting;
  const asks = input.askedTitles.map((t) => `• ${t}`).join('\n');
  const dones = input.doneTitles.map((t) => `• ${t}`).join('\n');

  const html = renderEmail({
    title: input.message,
    preheader: input.message,
    eyebrow: 'Piloto automático',
    pillHtml: statusPill({
      label: waiting > 0 ? `${waiting} por decidir` : 'Nada por decidir',
      tone: waiting > 0 ? 'warn' : 'success',
    }),
    bodyHtml: [
      lede('Esto es lo que hice esta mañana en la empresa, y lo que necesita tu decisión.'),
      statRow([
        { label: 'Hice', value: String(input.done) },
        { label: 'Por decidir', value: String(waiting) },
        { label: 'No salieron', value: input.failed ? String(input.failed) : '' },
      ]),
      waiting > 0 && asks
        ? calloutBox({ tone: 'warn', title: 'Necesita tu decisión', text: asks })
        : '',
      dones ? calloutBox({ tone: 'success', title: 'Lo que hice', text: dones }) : '',
      url ? button({ href: url, label: 'Ver lo que hice hoy' }) : '',
      fineprint(
        'Cada cosa tiene su razón y cómo la verifiqué. Puedes apagar el piloto o cambiar lo que hace solo en Piloto automático.',
      ),
    ]
      .filter(Boolean)
      .join(''),
    footerNote:
      'Cortex corre el piloto automático porque un administrador de tu empresa lo encendió.',
  });

  const text = [
    `PILOTO AUTOMÁTICO — ${input.day}`,
    '',
    input.message,
    '',
    waiting > 0 && asks ? `Necesita tu decisión:\n${asks}\n` : '',
    dones ? `Lo que hice:\n${dones}\n` : '',
    url ? `Ver lo que hice hoy: ${url}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject: `Piloto automático: ${input.message}`.slice(0, 200), html, text };
}
