import type { SheetData, SheetValue } from '../kb/spreadsheets';
import type { DuplicateRule } from '../trackers/duplicates';
import { type FieldFormat, checkFormat } from '../trackers/formats';
import type { TrackerField } from '../trackers/schema';
import { dayOfCell } from '../views/feed-sources';
import { fieldsFromSheet } from './sync';

/**
 * PROPONER LA TABLA ANTES DE CREARLA.
 *
 * Cuando alguien da una hoja como fuente de una tabla (y de la vista que la
 * muestra), Cortex no la crea a ciegas: la LEE y propone los campos —tipo,
 * opciones, obligatorios, formato, cuál identifica cada fila y si conviene
 * marcar duplicados— con la evidencia de por qué («200 de 200 llenas», «12
 * valores distintos»). La persona aprueba o corrige y recién ahí se crea.
 *
 * Todo aquí es puro y prudente: una sugerencia sólo sale cuando TODAS las
 * celdas con algo la cumplen y hay suficientes para creerle (MIN_EVIDENCE).
 * Una regla de más bloquea registros buenos el día uno; una de menos se agrega
 * después en «Campos y reglas».
 */

const MIN_EVIDENCE = 5;
const SAMPLE_ROWS = 200;

/** Encabezados que suelen identificar una fila. */
const ID_HINT =
  /\b(c[oó]digo|n[uú]mero|no\.?|nro|n°|#|id|gu[ií]a|awb|factura|pedido|orden|remisi[oó]n|ref(erencia)?|serial|serie|placa|nit|documento|sku|lote)\b/i;
const STATUS_HINT = /\b(estado|status|situaci[oó]n|etapa)\b/i;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const BOOL_TRUE = /^(s[ií]|si|yes|true|x|✓|1)$/i;
const BOOL_FALSE = /^(no|false|0|-)$/i;

export interface ProposedField extends TrackerField {
  /** El encabezado de la hoja del que sale. */
  sourceColumn: string;
  /** Por qué se propone así, en español, para mostrarlo. */
  why: string[];
  /** Hasta tres valores de ejemplo de la hoja. */
  samples: string[];
}

export interface TableProposal {
  fields: ProposedField[];
  /** Columnas de la hoja que identifican una fila (para `keyColumns`). */
  keyColumns: string[];
  keyWhy: string;
  /** Regla de duplicados sugerida, si la hoja la justifica. */
  duplicates: (DuplicateRule & { why: string }) | null;
  rows: number;
  /** Lo que no se pudo leer o conviene revisar. */
  notes: string[];
}

function text(cell: SheetValue | undefined): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).trim();
}

const FORMAT_CHECKS: Array<{ format: FieldFormat; header?: RegExp }> = [
  { format: 'email' },
  { format: 'awb', header: /\b(gu[ií]a|awb|mawb|hawb)\b/i },
  { format: 'nit', header: /\bnit\b/i },
  { format: 'plate', header: /\bplaca\b/i },
  { format: 'phone', header: /\b(tel[eé]fono|celular|m[oó]vil|whatsapp|tel)\b/i },
];

export function proposeTableFromSheet(sheet: SheetData): TableProposal {
  const header = (sheet.rows[0] ?? []).map((h) => text(h));
  const data = sheet.rows.slice(1, SAMPLE_ROWS + 1);
  const rows = data.length;
  const base = fieldsFromSheet(sheet);
  const notes: string[] = [];
  if (sheet.rows.length - 1 > SAMPLE_ROWS)
    notes.push(`Propuse con las primeras ${SAMPLE_ROWS} filas de ${sheet.rows.length - 1}.`);

  const fields: ProposedField[] = base.fields.map((field) => {
    const sourceColumn = base.mapping[field.key] ?? field.label;
    const col = header.findIndex((h) => h === sourceColumn);
    const cells = col >= 0 ? data.map((r) => text(r[col])) : [];
    const filled = cells.filter(Boolean);
    const why: string[] = [];
    const out: ProposedField = {
      ...field,
      sourceColumn,
      why,
      samples: [...new Set(filled)].slice(0, 3),
    };
    const enough = filled.length >= MIN_EVIDENCE;

    // Tipos que la inferencia de vistas no conoce: hora, casilla, texto largo.
    if (field.type === 'text' && enough) {
      if (filled.every((c) => TIME_RE.test(c))) {
        out.type = 'time';
        why.push('todas las celdas son horas');
      } else if (filled.every((c) => BOOL_TRUE.test(c) || BOOL_FALSE.test(c))) {
        out.type = 'checkbox';
        why.push('sólo trae sí / no');
      } else if (filled.reduce((n, c) => n + c.length, 0) / filled.length > 80) {
        out.type = 'longtext';
        why.push('textos largos');
      }
    }
    // «Sí / No» parece una lista de dos opciones, pero es una casilla.
    if (
      out.type === 'select' &&
      enough &&
      filled.every((c) => BOOL_TRUE.test(c) || BOOL_FALSE.test(c))
    ) {
      out.type = 'checkbox';
      out.options = undefined;
      why.push('sólo trae sí / no');
    }
    if (out.type === 'select') why.push(`${out.options?.length ?? 0} valores que se repiten`);
    if (out.type === 'date') why.push('todas las celdas son fechas');
    if (out.type === 'number' || out.type === 'money')
      why.push(
        out.type === 'money' ? 'números y el encabezado habla de plata' : 'todo son números',
      );

    // Obligatorio: sólo si la hoja nunca lo dejó vacío.
    if (rows >= MIN_EVIDENCE && filled.length === rows) {
      out.required = true;
      why.push(`lleno en las ${rows} filas`);
    } else if (rows) {
      why.push(`lleno en ${filled.length} de ${rows}`);
    }

    // Formato: todas las celdas lo cumplen; los que se confunden con un número
    // cualquiera (teléfono, NIT, placa, guía) además piden el encabezado.
    if ((out.type === 'text' || out.type === 'number') && enough) {
      for (const { format, header: hint } of FORMAT_CHECKS) {
        if (hint && !hint.test(sourceColumn)) continue;
        if (filled.every((c) => checkFormat(format, c))) {
          out.type = 'text';
          out.format = format;
          why.push(`todas tienen formato de ${format === 'email' ? 'correo' : format}`);
          break;
        }
      }
    }
    return out;
  });

  // La clave: una columna con pinta de identificador, siempre llena y sin
  // repetidos; si se repite, la combinación con una fecha.
  const colOf = (f: ProposedField) => header.findIndex((h) => h === f.sourceColumn);
  const valuesOf = (f: ProposedField) => data.map((r) => text(r[colOf(f)]));
  const idLike = fields.filter(
    (f) => ID_HINT.test(f.sourceColumn) && (f.type === 'text' || f.type === 'number'),
  );
  const dateField = fields.find((f) => f.type === 'date');
  let keyColumns: string[] = [];
  let keyWhy = '';
  let duplicates: TableProposal['duplicates'] = null;
  for (const f of idLike) {
    const vals = valuesOf(f);
    if (vals.some((v) => !v)) continue;
    const distinct = new Set(vals.map((v) => v.toLowerCase()));
    if (distinct.size === vals.length) {
      keyColumns = [f.sourceColumn];
      keyWhy = `«${f.label}» está siempre lleno y no se repite.`;
      f.unique = true;
      f.why.push('no se repite: identifica cada fila');
      break;
    }
    if (dateField) {
      const dates = valuesOf(dateField);
      const pairs = new Set(
        vals.map((v, i) => `${v.toLowerCase()}|${dayOfCell(dates[i] ?? '') ?? ''}`),
      );
      if (pairs.size === vals.length) {
        keyColumns = [f.sourceColumn, dateField.sourceColumn];
        keyWhy = `«${f.label}» se repite, pero nunca con la misma «${dateField.label}».`;
        // El mismo código con otra fecha suele ser un error de digitación:
        // se propone marcarlo, no bloquearlo.
        const status = fields.find((x) => x.type === 'select' && STATUS_HINT.test(x.sourceColumn));
        duplicates = {
          key: f.key,
          distinctBy: dateField.key,
          flagField: status?.key ?? 'estado',
          flagValue: 'Duplicado',
          why: `Hay ${vals.length - new Set(vals.map((v) => v.toLowerCase())).size} «${f.label}» repetidos con distinta fecha; conviene marcarlos para revisar.`,
        };
        if (status && !status.options?.includes('Duplicado'))
          status.options = [...(status.options ?? []), 'Duplicado'];
        break;
      }
    }
  }
  if (duplicates && !fields.some((f) => f.key === duplicates?.flagField)) {
    fields.push({
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Duplicado'],
      sourceColumn: '',
      why: ['nuevo: para marcar los duplicados (no viene de la hoja)'],
      samples: [],
    });
  }
  if (!keyColumns.length) {
    keyWhy =
      'Ninguna columna identifica cada fila por sí sola; pregúntale a la persona cuál usar (o qué combinación).';
    notes.push(keyWhy);
  }
  return { fields: fields.slice(0, 20), keyColumns, keyWhy, duplicates, rows, notes };
}

/** La propuesta como tabla para el chat. */
export function proposalMarkdown(p: TableProposal, sourceName: string): string {
  const typeName: Record<string, string> = {
    text: 'Texto',
    longtext: 'Texto largo',
    number: 'Número',
    money: 'Dinero',
    date: 'Fecha',
    time: 'Hora',
    checkbox: 'Sí / No',
    select: 'Lista',
  };
  const lines = [
    `Leí «${sourceName}» (${p.rows} filas). Te propongo esta tabla:`,
    '',
    '| Campo | Tipo | Reglas | Ejemplo |',
    '|---|---|---|---|',
    ...p.fields.map((f) => {
      const rules = [
        f.required ? 'obligatorio' : '',
        f.unique ? 'único' : '',
        f.format ? `formato ${f.format}` : '',
        f.type === 'select' && f.options?.length
          ? `opciones: ${f.options.slice(0, 6).join(', ')}${f.options.length > 6 ? '…' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `| ${f.label} | ${typeName[f.type] ?? f.type} | ${rules || '—'} | ${f.samples[0] ?? ''} |`;
    }),
    '',
    p.keyColumns.length
      ? `**Cada fila se identifica por:** ${p.keyColumns.join(' + ')}. ${p.keyWhy}`
      : `**Falta decidir:** ${p.keyWhy}`,
    ...(p.duplicates ? [`**Duplicados:** ${p.duplicates.why}`] : []),
    ...p.notes.filter((n) => n !== p.keyWhy).map((n) => `_${n}_`),
    '',
    '¿La creo así o quieres cambiar algo (nombres, tipos, obligatorios, opciones)?',
  ];
  return lines.join('\n');
}
