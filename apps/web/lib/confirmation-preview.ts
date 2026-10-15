/**
 * «QUÉ VA A CAMBIAR», COMO VISTA PREVIA.
 *
 * Una función pura que convierte (herramienta, entrada, valores de antes) en
 * renglones que la tarjeta dibuja: `campo: antes → después` para una fila que
 * se edita, `para / asunto / cuerpo` para un correo, los campos para una
 * creación, y sólo la DIFERENCIA de campos para una tabla que ya existe. NO
 * escribe ni lee nada: los valores de antes los trae, si existen,
 * /api/chat/confirm/preview (que sólo lee). Los valores estructurados nunca se
 * pasan por String(): ver confirmation-values.ts.
 */

import { canonicalInput } from './confirmation-claim';
import {
  TECHNICAL_KEYS,
  describeItem,
  labelFor,
  renderValue,
  renderedSummary,
  truncate,
  typeLabel,
} from './confirmation-values';

export type PreviewKind = 'diff' | 'email' | 'fields';

export interface PreviewRow {
  key: string;
  label: string;
  before?: string;
  after: string;
  changed: boolean;
  long?: boolean;
  /** Un valor estructurado: una línea por elemento (el total puede ser mayor). */
  items?: string[];
  total?: number;
  /** El texto completo cuando `after` va recortado («ver más»). */
  full?: string;
  /** Texto secundario bajo el valor: «Identificador: atenciones». */
  secondary?: string;
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
  /** trackers.define: ¿la tabla ya existe? (undefined = aún no se sabe). */
  trackerExists?: boolean;
  /** trackers.define: la definición actual, para enseñar sólo lo que cambia. */
  trackerBefore?: { name?: string; description?: string; fields: unknown[] } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function formatValue(v: unknown, max = 400): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return new Intl.NumberFormat('es-CO').format(v);
  if (typeof v === 'string') return truncate(v, max);
  return truncate(renderedSummary(renderValue(v, { max })), max);
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

/** Un renglón para cualquier valor: texto, lista o líneas, nunca «[object Object]». */
function rowFor(key: string, label: string, value: unknown): PreviewRow {
  const r = renderValue(value);
  if (r.kind === 'text')
    return {
      key,
      label,
      after: r.text,
      changed: true,
      long: typeof value === 'string' && value.length > 120,
      ...(r.full ? { full: r.full } : {}),
    };
  return {
    key,
    label,
    after: renderedSummary(r),
    changed: true,
    items: r.items,
    total: r.total,
  };
}

// ---- trackers.define ------------------------------------------------------

/** Lo que importa de un campo para compararlo: sin los valores por omisión. */
function normalizeField(f: unknown): string {
  if (!isRecord(f)) return canonicalInput(f);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  return canonicalInput(clean);
}

const FIELD_PROP_LABEL: Record<string, string> = {
  label: 'nombre',
  type: 'tipo',
  required: 'obligatorio',
  options: 'opciones',
};

function propText(k: string, v: unknown): string {
  if (k === 'type') return typeLabel(v);
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (Array.isArray(v)) return truncate(v.map(String).join(', ') || 'ninguna', 50);
  return truncate(String(v ?? (k === 'options' ? 'ninguna' : 'ninguno')), 40);
}

/** «Estado · tipo: Texto → Opciones; obligatorio: no → sí». */
export function describeFieldChange(before: unknown, after: unknown): string {
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  const name = describeItem({ label: a.label ?? a.key ?? b.key }).split(' · ')[0] ?? '';
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const changes: string[] = [];
  let others = 0;
  for (const k of keys) {
    const x = b[k];
    const y = a[k];
    const blank = (v: unknown) => v === undefined || v === null || v === false || v === '';
    if ((blank(x) && blank(y)) || canonicalInput(x) === canonicalInput(y)) continue;
    const label = FIELD_PROP_LABEL[k];
    if (!label) {
      others += 1;
      continue;
    }
    changes.push(`${label}: ${propText(k, x)} → ${propText(k, y)}`);
  }
  if (others > 0) changes.push(others === 1 ? 'un ajuste' : `${others} ajustes`);
  return changes.length ? `${name} · ${changes.join('; ')}` : name;
}

export interface FieldsDiff {
  added: unknown[];
  removed: unknown[];
  changed: Array<{ before: unknown; after: unknown }>;
  same: number;
}

/** Los campos que se agregan, se quitan o cambian, comparados por su llave. */
export function diffFields(before: unknown[], after: unknown[]): FieldsDiff {
  const keyOf = (f: unknown) => (isRecord(f) && typeof f.key === 'string' ? f.key : null);
  const prior = new Map(
    before.flatMap((f) => (keyOf(f) ? [[keyOf(f) as string, f] as const] : [])),
  );
  const next = new Map(after.flatMap((f) => (keyOf(f) ? [[keyOf(f) as string, f] as const] : [])));
  const out: FieldsDiff = { added: [], removed: [], changed: [], same: 0 };
  for (const [k, f] of next) {
    const was = prior.get(k);
    if (was === undefined) out.added.push(f);
    else if (normalizeField(was) !== normalizeField(f)) out.changed.push({ before: was, after: f });
    else out.same += 1;
  }
  for (const [k, f] of prior) if (!next.has(k)) out.removed.push(f);
  return out;
}

function buildTrackerDefinePreview(
  input: Record<string, unknown>,
  ctx: PreviewContext,
): ConfirmationPreview {
  const name = typeof input.name === 'string' ? input.name : '';
  const slug = typeof input.slug === 'string' ? input.slug : '';
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const secondary = slug ? `Identificador: ${slug}` : undefined;
  const before = ctx.trackerBefore;

  if (before) {
    const rows: PreviewRow[] = [];
    if (name && before.name && name !== before.name)
      rows.push({ key: 'name', label: 'Nombre', before: before.name, after: name, changed: true });
    const desc = typeof input.description === 'string' ? input.description : '';
    if (desc !== (before.description ?? '') && (desc || before.description))
      rows.push({
        key: 'description',
        label: 'Descripción',
        before: truncate(before.description || '—', 80),
        after: truncate(desc || '—', 80),
        changed: true,
      });
    const d = diffFields(before.fields, fields);
    const list = (key: string, label: string, items: string[]) =>
      rows.push({
        key,
        label,
        after: `${items.length}`,
        changed: true,
        items,
        total: items.length,
      });
    if (d.added.length) list('added', 'Campos nuevos', d.added.map(describeItem));
    if (d.changed.length)
      list(
        'changed',
        'Campos que cambian',
        d.changed.map((c) => describeFieldChange(c.before, c.after)),
      );
    if (d.removed.length) list('removed', 'Campos que se quitan', d.removed.map(describeItem));
    if (d.same > 0 || rows.length === 0)
      rows.push({
        key: 'same',
        label: 'Campos',
        after: d.same === 1 ? '1 campo' : `${d.same} campos`,
        changed: false,
      });
    return { kind: 'diff', heading: `Cambios en la tabla${name ? ` «${name}»` : ''}`, rows };
  }

  const rows: PreviewRow[] = [];
  if (name)
    rows.push({
      key: 'name',
      label: 'Nombre',
      after: name,
      changed: true,
      ...(secondary ? { secondary } : {}),
    });
  if (typeof input.description === 'string' && input.description)
    rows.push(rowFor('description', 'Descripción', input.description));
  rows.push(rowFor('fields', 'Campos', fields));
  if (input.duplicates) rows.push(rowFor('duplicates', labelFor('duplicates'), input.duplicates));
  return {
    kind: 'fields',
    ...(ctx.trackerExists === false ? { heading: 'Tabla nueva' } : {}),
    rows,
  };
}

export function buildPreview(
  toolId: string,
  input: unknown,
  ctx: PreviewContext = {},
): ConfirmationPreview | null {
  if (!isRecord(input)) return null;

  if (toolId === 'trackers.define') return buildTrackerDefinePreview(input, ctx);

  if (toolId === 'trackers.upsert' && isRecord(input.values)) {
    const before = ctx.before ?? null;
    const editing = typeof input.rowId === 'string' && input.rowId.length > 0;
    const rows = Object.entries(input.values)
      .slice(0, MAX_ROWS)
      .map(([key, value]): PreviewRow => {
        const label = ctx.fieldLabels?.[key] ?? labelFor(key);
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
  // El identificador (slug) no es un renglón: va debajo del nombre, en pequeño.
  const slug = typeof input.slug === 'string' ? input.slug : '';
  let slugPlaced = false;
  for (const [key, value] of Object.entries(input)) {
    if (SKIP.has(key) || value === undefined) continue;
    if (TECHNICAL_KEYS.has(key)) {
      if (key !== 'slug') continue;
      // Sin nombre ni título al que colgarlo, se enseña como «Identificador».
      if (typeof input.name === 'string' || typeof input.title === 'string') continue;
    }
    if (isRecord(value) && Object.values(value).every((x) => x === null || typeof x !== 'object')) {
      for (const [k2, v2] of Object.entries(value)) {
        rows.push({
          key: `${key}.${k2}`,
          label: labelFor(k2),
          after: formatValue(v2),
          changed: true,
        });
      }
    } else {
      const row = rowFor(key, labelFor(key), value);
      if (slug && (key === 'name' || key === 'title') && !slugPlaced) {
        row.secondary = `Identificador: ${slug}`;
        slugPlaced = true;
      }
      rows.push(row);
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
  if (toolId === 'trackers.define') {
    const verb =
      ctx.trackerExists === true
        ? 'Cambiar la tabla'
        : ctx.trackerExists === false
          ? 'Crear la tabla'
          : 'Crear o cambiar la tabla';
    return `${verb}${input.name ? ` «${str(input.name)}»` : ''}`;
  }
  return null;
}
