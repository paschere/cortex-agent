import { button, calloutBox, divider, fineprint, keyValueTable, lede, statRow } from './components';
import { type RenderedEmail, appBaseUrl, renderEmail } from './layout';
import { escapeHtml, FONT_STACK, palette } from './theme';

/**
 * El parte semanal, como correo.
 *
 * ===========================================================================
 * QUÉ TIENE QUE HACER ESTE CORREO EN LOS PRIMEROS DOS SEGUNDOS
 * ===========================================================================
 * Llega un lunes a las siete de la mañana sin que nadie lo pidiera, así que
 * compite contra el botón de archivar. Lo que decide si se lee es lo que se ve
 * antes de hacer scroll, y por eso:
 *
 *   EL ASUNTO LLEVA EL HALLAZGO, no el nombre del informe. «Parte semanal» es
 *   una etiqueta; «3 vencidos, 2 cobros sin respuesta» es una razón para abrir.
 *   Cuando no hay nada urgente el asunto lo dice también, porque un asunto
 *   alarmante sobre una semana tranquila es la forma más rápida de que la
 *   tercera semana ya no se abra.
 *
 *   EL CUERPO ES UN RESUMEN, NO EL INFORME. El informe entero está en la
 *   aplicación, con sus gráficos y con la fuente de cada cifra. Reproducirlo en
 *   HTML de correo produciría una segunda versión que puede desviarse de la
 *   primera, y este producto entero se sostiene sobre que hay UNA cifra por
 *   pregunta.
 *
 * ===========================================================================
 * DE DÓNDE SALE CADA LÍNEA
 * ===========================================================================
 * De `ReportDocument`, ya resuelto: las cifras vienen con su `display` ya
 * formateado y su `method` ya escrito. Esta plantilla NO calcula nada, no suma,
 * no redondea y no reordena — si lo hiciera, el correo y el informe podrían
 * decir números distintos y no habría manera de saber cuál miente.
 *
 * Las notas del documento («esto no incluye…») viajan enteras. Son la parte que
 * hace honesto al resto, y recortarlas para que el correo quede más limpio es
 * exactamente el recorte que no se puede hacer.
 *
 * Español (Colombia), tuteo, frase normal. Cero llamadas al modelo: todo el
 * texto de aquí son reglas y plantillas.
 */

export interface WeeklyReportEmailInput {
  reportId: string;
  title: string;
  /** «semana del 3 al 9 de agosto de 2026 · …», tal como lo dice el informe. */
  periodLabel: string;
  /** «del 3 al 9 de agosto de 2026», para un asunto que quepa en un móvil. */
  weekLabel: string;
  /** El primer párrafo del informe. Ya escrito por el constructor. */
  lede: string;
  /** Las cifras del bloque de métricas, en orden y ya formateadas. */
  figures: Array<{ label: string; display: string; sub: string | null }>;
  /** Los renglones que exigen una decisión: lo vencido, los silencios. */
  headlines: string[];
  /** Qué no incluye el parte. Del documento, sin tocar. */
  notes: string[];
  /** Cuántas fuentes declaró el informe: el correo lo dice, no lo demuestra. */
  sourceCount: number;
}

/**
 * El asunto: el hallazgo primero, la semana después.
 *
 * EL ORDEN NO ES ESTILO. Gmail y Apple Mail cortan el asunto alrededor de los
 * setenta caracteres en un teléfono, así que lo que va primero es lo único que
 * se lee de verdad. «Parte semanal del 27 de julio al 2 de agosto» gasta esos
 * setenta caracteres en decir el nombre del archivo; «2 vencidos; 1 cobro sin
 * respuesta» gasta veinte en decir por qué abrirlo.
 *
 * Se arma de los titulares que ya trae el documento, no de una plantilla
 * aparte, para que asunto y cuerpo no puedan contradecirse. Y cuando la semana
 * fue tranquila lo dice tal cual: un asunto alarmante sobre una semana sin nada
 * es la forma más rápida de que la tercera semana ya no se abra.
 */
export function weeklySubject(input: { headlines: string[]; weekLabel: string }): string {
  if (input.headlines.length === 0) {
    return `Parte semanal: nada pendiente de decidir (${input.weekLabel})`.slice(0, 160);
  }
  const head = input.headlines.slice(0, 2).join('; ');
  return `${head} — parte semanal ${input.weekLabel}`.slice(0, 160);
}

/** Los titulares, como lista con viñetas de verdad y no como párrafo. */
function headlineList(headlines: string[]): string {
  if (headlines.length === 0) return '';
  const items = headlines
    .map(
      (h) =>
        `<li style="margin:0 0 6px;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${palette.ink};">${escapeHtml(h)}</li>`,
    )
    .join('');
  return `<ul style="margin:0 0 20px;padding-left:20px;">${items}</ul>`;
}

export function renderWeeklyReportEmail(input: WeeklyReportEmailInput): RenderedEmail {
  const base = appBaseUrl();
  const reportUrl = base ? `${base}/reports/${input.reportId}` : '';
  const subject = weeklySubject({ headlines: input.headlines, weekLabel: input.weekLabel });

  // Cuatro como mucho: `statRow` no dibuja más, y cinco cifras en una fila en un
  // teléfono no se leen. Las demás van íntegras en la tabla de abajo.
  const tiles = input.figures.slice(0, 4).map((f) => ({ label: f.label, value: f.display }));

  const bodyHtml = [
    lede(input.lede),
    headlineList(input.headlines),
    statRow(tiles),
    keyValueTable(
      input.figures.map((f) => ({
        label: f.label,
        value: f.sub ? `${f.display} — ${f.sub}` : f.display,
      })),
    ),
    reportUrl ? button({ href: reportUrl, label: 'Ver el parte completo' }) : '',
    divider(),
    calloutBox({
      tone: 'neutral',
      title: 'Qué no dice este parte',
      text: input.notes.join(' '),
    }),
    fineprint(
      `Cada cifra del informe trae la fuente de la que salió y la cuenta que se hizo con ella; este parte declaró ${input.sourceCount} ${input.sourceCount === 1 ? 'fuente' : 'fuentes'}. No hay ingresos, ni crecimiento, ni márgenes: eso no lo sé.`,
    ),
  ]
    .filter(Boolean)
    .join('');

  const html = renderEmail({
    title: input.title,
    preheader: `${input.lede}`.slice(0, 160),
    eyebrow: 'Parte semanal',
    bodyHtml,
    footerNote:
      'Este parte sale solo cada lunes temprano y va a quien responde por la empresa. Se apaga en Ajustes, en un clic.',
  });

  const text = [
    input.title.toUpperCase(),
    input.periodLabel,
    '',
    input.lede,
    '',
    ...(input.headlines.length > 0
      ? ['LO QUE PIDE UNA DECISIÓN', ...input.headlines.map((h) => `- ${h}`), '']
      : []),
    'LAS CIFRAS',
    ...input.figures.map((f) => `- ${f.label}: ${f.display}${f.sub ? ` (${f.sub})` : ''}`),
    '',
    'QUÉ NO DICE ESTE PARTE',
    ...input.notes.map((n) => `- ${n}`),
    '',
    reportUrl ? `El parte completo, con gráficos y fuentes: ${reportUrl}` : '',
    '',
    'Sale solo cada lunes temprano. Se apaga en Ajustes.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return { subject, html, text };
}
