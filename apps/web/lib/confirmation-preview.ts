/**
 * «QUÉ VA A CAMBIAR», COMO VISTA PREVIA.
 *
 * Una función pura que convierte (herramienta, entrada, valores de antes) en
 * renglones que la tarjeta dibuja: `campo: antes → después` para una fila que
 * se edita, `para / asunto / cuerpo` para un correo, los campos para una
 * creación. NO escribe ni lee nada: los valores de antes los trae, si existen,
 * /api/chat/confirm/preview (que sólo lee).
 */

export type PreviewKind = 'diff' | 'email' | 'fields';

export interface PreviewRow {
  key: string;
  label: string;
  before?: string;
  after: string;
  changed: boolean;
  long?: boolean;
}

export interface ConfirmationPreview {
  kind: PreviewKind;
  /** «Fila de Clientes», «Correo a ana@x.com»… */
  heading?: string;
  rows: PreviewRow[];
}

export interface PreviewContext {
  /** Los valores actuales de la fila que se edita (sólo lectura). */
  before?: Record<string, unknown> | null;
  /** Etiqueta legible de cada campo de la tabla. */
  fieldLabels?: Record<string, string>;
  trackerName?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function formatValue(v: unknown, max = 400): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return new Intl.NumberFormat('es-CO').format(v);
  const text =
    typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : JSON.stringify(v);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function humanKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const SKIP = new Set(['repeatConfirmedByUser', 'rowId', 'tracker', 'draftId']);
const MAX_ROWS = 12;

const EMAIL_FIELDS: Array<[string, string]> = [
  ['to', 'Para'],
  ['cc', 'Cc'],
  ['bcc', 'Cco'],
  ['subject', 'Asunto'],
  ['body', 'Mensaje'],
];

const EMAIL_TOOLS = new Set(['gmail.send_draft', 'gmail.send_message', 'gmail.draft']);

export function buildPreview(
  toolId: string,
  input: unknown,
  ctx: PreviewContext = {},
): ConfirmationPreview | null {
  if (!isRecord(input)) return null;

  if (toolId === 'trackers.upsert' && isRecord(input.values)) {
    const before = ctx.before ?? null;
    const editing = typeof input.rowId === 'string' && input.rowId.length > 0;
    const rows = Object.entries(input.values)
      .slice(0, MAX_ROWS)
      .map(([key, value]): PreviewRow => {
        const label = ctx.fieldLabels?.[key] ?? humanKey(key);
        const after = formatValue(value);
        if (editing && before) {
          const prior = formatValue(before[key]);
          return { key, label, before: prior, after, changed: prior !== after };
        }
        return { key, label, after, changed: true };
      });
    const where = ctx.trackerName ? ` en ${ctx.trackerName}` : '';
    return {
      kind: editing && before ? 'diff' : 'fields',
      heading: editing ? `Editar una fila${where}` : `Fila nueva${where}`,
      rows,
    };
  }

  if (EMAIL_TOOLS.has(toolId)) {
    const rows = EMAIL_FIELDS.flatMap(([key, label]): PreviewRow[] =>
      key in input && input[key] !== undefined && input[key] !== ''
        ? [
            {
              key,
              label,
              after: formatValue(input[key], 1200),
              changed: true,
              long: key === 'body',
            },
          ]
        : [],
    );
    if (rows.length > 0) return { kind: 'email', heading: 'El correo, tal cual saldrá', rows };
    if (typeof input.draftId === 'string')
      return {
        kind: 'email',
        heading: 'El correo, tal cual saldrá',
        rows: [{ key: 'draftId', label: 'Borrador', after: input.draftId, changed: true }],
      };
  }

  const rows: PreviewRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (SKIP.has(key) || value === undefined) continue;
    if (isRecord(value)) {
      for (const [k2, v2] of Object.entries(value)) {
        if (typeof v2 === 'object' && v2 !== null) continue;
        rows.push({
          key: `${key}.${k2}`,
          label: humanKey(k2),
          after: formatValue(v2),
          changed: true,
        });
      }
    } else {
      rows.push({
        key,
        label: humanKey(key),
        after: formatValue(value),
        changed: true,
        long: typeof value === 'string' && value.length > 120,
      });
    }
    if (rows.length >= MAX_ROWS) break;
  }
  return rows.length > 0 ? { kind: 'fields', rows: rows.slice(0, MAX_ROWS) } : null;
}

/**
 * La acción en una frase de español para el encabezado de la tarjeta, o null
 * para que la tarjeta use `confirmationSummary` (lib/tool-labels.ts).
 */
export function headlineFor(
  toolId: string,
  input: unknown,
  ctx: PreviewContext = {},
): string | null {
  if (!isRecord(input)) return null;
  const str = (v: unknown, max = 80): string =>
    typeof v === 'string' ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : '';
  if (toolId === 'trackers.upsert') {
    const where = ctx.trackerName ?? str(input.tracker);
    const editing = typeof input.rowId === 'string' && input.rowId.length > 0;
    return `${editing ? 'Actualizar una fila de' : 'Agregar una fila a'}${where ? ` «${where}»` : ' una tabla'}`;
  }
  if (toolId === 'gmail.send_message' || toolId === 'gmail.send_draft') {
    const to = Array.isArray(input.to) ? input.to.join(', ') : str(input.to, 60);
    const subject = str(input.subject, 60);
    return `Enviar un correo${to ? ` a ${to}` : ''}${subject ? ` — «${subject}»` : ''}`;
  }
  if (toolId === 'views.create')
    return `Crear la vista${input.title ? ` «${str(input.title)}»` : ''}`;
  if (toolId === 'trackers.define')
    return `Crear o cambiar la tabla${input.name ? ` «${str(input.name)}»` : ''}`;
  return null;
}
