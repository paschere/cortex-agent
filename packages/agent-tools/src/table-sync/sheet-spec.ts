import { z } from 'zod';
import type { SheetData, SheetValue } from '../kb/spreadsheets';
import { dayOfCell } from '../views/feed-sources';

/**
 * SINCRONIZACIÓN POR RECETA (migración 0248): una pestaña → una tabla de filas
 * (hijas) y, si la receta lo pide, otra de grupos (padres), con relación entre
 * ellas.
 *
 * Es el mismo motor de `tracker_syncs` (fuente del Feed → tabla) con una
 * `spec` guardada en la base en vez de «campo = encabezado»: la receta dice qué
 * columna alimenta cada variable, cómo se limpia (texto, números, fechas,
 * tablas de equivalencias, expresiones), qué filas son filas de verdad y cuáles
 * son cargos del grupo, cómo se arma la clave (una plantilla, compuesta) y qué
 * campos se escriben siempre, sólo al crear, o no se tocan si la app ya los
 * movió a otro estado. Nada aquí sabe de un cliente: la receta de cada empresa
 * es DATOS.
 *
 * Este archivo es PURO (sin base de datos): `planGrouped` convierte una
 * pestaña en lo que debería existir. Compararlo con lo que hay y escribirlo es
 * de `sheet-spec-sync.ts`.
 */

export const SPEC_ROW_CAP = 20_000;
const MAX = 400;

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------

const patternSchema = z.string().min(1).max(200);
const flagsSchema = z
  .string()
  .regex(/^[gimsu]{0,5}$/)
  .optional();

export const opSchema = z.discriminatedUnion('op', [
  /** Texto limpio: recorta y junta espacios repetidos. */
  z.object({ op: z.literal('text') }),
  /** Sólo recorta los extremos (respeta los espacios de adentro). */
  z.object({ op: z.literal('trim') }),
  z.object({ op: z.literal('upper') }),
  z.object({ op: z.literal('lower') }),
  /** Sólo los dígitos («N° 1165…» → «1165…»). */
  z.object({ op: z.literal('digits') }),
  z.object({ op: z.literal('number') }),
  z.object({ op: z.literal('round'), digits: z.number().int().min(0).max(8).default(2) }),
  /** `formats`: además de ISO, los textos «M/D/Y» o «D/M/Y» que traiga la hoja. */
  z.object({
    op: z.literal('date'),
    formats: z.array(z.enum(['M/D/Y', 'D/M/Y'])).max(2).optional(),
  }),
  z.object({
    op: z.literal('replace'),
    pattern: patternSchema,
    flags: flagsSchema,
    with: z.string().max(80),
  }),
  /** Se queda con un grupo de la expresión (vacío si no calza). */
  z.object({
    op: z.literal('extract'),
    pattern: patternSchema,
    flags: flagsSchema,
    group: z.number().int().min(0).max(9).default(1),
  }),
  /** Equivalencias: «COLOCAR» → «Colocar Cargo Logistics». Sin normalize, la clave es exacta. */
  z.object({
    op: z.literal('map'),
    table: z.record(z.string().max(120), z.union([z.string().max(200), z.number()])),
    /** Compara sin mayúsculas, tildes ni espacios sobrantes (por defecto sí). */
    normalize: z.boolean().default(true),
    /** Lo que no está en la tabla: se deja como estaba (por defecto) o queda vacío. */
    unmapped: z.enum(['keep', 'empty']).default('keep'),
  }),
  /** Si el texto calza: `then`; si no: `else` (o vacío). */
  z.object({
    op: z.literal('test'),
    pattern: patternSchema,
    flags: flagsSchema,
    then: z.union([z.string().max(200), z.number()]),
    else: z.union([z.string().max(200), z.number()]).optional(),
  }),
  /** Valor cuando la celda viene vacía. */
  z.object({ op: z.literal('default'), value: z.union([z.string().max(200), z.number()]) }),
]);
export type Op = z.infer<typeof opSchema>;

const condSchema = z
  .object({
    var: z.string().max(60),
    empty: z.boolean().optional(),
    equals: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(50)]).optional(),
    not: z.boolean().optional(),
  })
  .refine((c) => c.empty !== undefined || c.equals !== undefined, {
    message: 'Una condición necesita `empty` o `equals`.',
  });
export type Cond = z.infer<typeof condSchema>;

const sourceFieldSchema = z.union([
  z.object({
    var: z.string().max(60),
    /** `insert`: sólo al crear la fila; después la app manda. */
    on: z.enum(['always', 'insert']).default('always'),
    /** Si la fila de la app ya tiene uno de estos valores, no se le escribe (p.ej. un estado que la app avanzó). */
    keepIf: z.array(z.string().max(80)).max(20).optional(),
    /** Una celda vacía NO borra lo que hay (por defecto sí se salta). */
    skipEmpty: z.boolean().default(true),
  }),
  z.object({
    const: z.union([z.string().max(200), z.number()]),
    on: z.enum(['always', 'insert']).default('insert'),
  }),
]);
export type SourceField = z.infer<typeof sourceFieldSchema>;

const relationSchema = z.object({
  /** Tabla relacionada (slug). */
  tracker: z.string().max(60),
  /** Campo de esa tabla con el que se compara (`label` = su nombre visible). */
  by: z.string().max(60).default('label'),
  var: z.string().max(60),
  numeric: z.boolean().default(false),
  on: z.enum(['always', 'insert']).default('always'),
});
export type RelationSpec = z.infer<typeof relationSchema>;

const aggSchema = z.object({
  agg: z.enum(['first', 'distinct', 'sum', 'max', 'allEqual']),
  var: z.string().max(60),
  sep: z.string().max(10).default(' / '),
  /** De qué filas del grupo: las normales, los cargos o todas. */
  rows: z.enum(['child', 'charge', 'all']).default('child'),
  /** `allEqual`: valor si todas las filas valen `equals`; si no, `else`. */
  equals: z.string().max(80).optional(),
  else: z.string().max(80).optional(),
  on: z.enum(['always', 'insert']).default('always'),
  keepIf: z.array(z.string().max(80)).max(20).optional(),
});

const deriveSchema = z.object({
  derive: z
    .array(
      z.object({
        when: z
          .array(
            z.object({
              field: z.string().max(60),
              empty: z.boolean().optional(),
              equals: z.union([z.string(), z.number()]).optional(),
            }),
          )
          .max(5)
          .optional(),
        value: z.string().max(200),
      }),
    )
    .min(1)
    .max(8),
  on: z.enum(['always', 'insert']).default('insert'),
});

export const sheetSpecSchema = z.object({
  version: z.literal(1),
  /** Pestaña: por nombre; si no está, por posición (0 = primera). `gid` sólo identifica la pestaña de una hoja nativa. */
  tab: z.object({
    name: z.string().max(120),
    index: z.number().int().min(0).max(50).optional(),
    gid: z.number().int().optional(),
  }),
  headerRows: z.number().int().min(0).max(10).default(1),
  rowCap: z.number().int().min(1).max(SPEC_ROW_CAP).default(SPEC_ROW_CAP),
  /** Variable → columna de la hoja («A», «O») o texto exacto del encabezado, más cómo se limpia. */
  vars: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
      z.object({
        /** Columna («A»), encabezado, o `$otra_variable` (se evalúan en orden de declaración). */
        from: z.string().max(120),
        ops: z.array(opSchema).max(12).default([]),
      }),
    )
    .refine((v) => Object.keys(v).length <= 60, 'Máximo 60 variables.'),
  /** Filas que se ignoran (todas las condiciones deben cumplirse para que cuente como fila). */
  rowWhen: z.array(condSchema).max(10).default([]),
  /** Filas que, en vez de ser fila, son un cargo del grupo (se suman al padre). */
  chargeWhen: z.array(condSchema).max(10).default([]),
  child: z.object({
    tracker: z.string().max(60),
    /** Plantilla de la clave externa: «import2026:{guia}|{manifiesto_n}». Una repetida lleva «#2», «#3»… */
    key: z.string().max(200),
    fields: z.record(z.string(), sourceFieldSchema).default({}),
    relations: z.record(z.string(), relationSchema).default({}),
    /** Campo de relación hacia el padre. */
    parentField: z.string().max(60).optional(),
  }),
  parent: z
    .object({
      tracker: z.string().max(60),
      groupVar: z.string().max(60),
      key: z.string().max(200),
      fields: z.record(z.string(), z.union([aggSchema, deriveSchema, sourceFieldSchema])).default({}),
    })
    .optional(),
  /** Una fila de la app cambiada desde esta fecha y distinta de la hoja es «conflicto» (gana la hoja). */
  conflictsSince: z.string().max(40).optional(),
});
export type SheetSpec = z.infer<typeof sheetSpecSchema>;

export function parseSheetSpec(raw: unknown): SheetSpec {
  const parsed = sheetSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`Receta de sincronización inválida: ${i?.path.join('.') ?? ''} ${i?.message ?? ''}`.trim());
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

type Val = string | number | undefined;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function colIndex(ref: string, header: string[]): number {
  const t = ref.trim();
  if (/^[A-Za-z]{1,2}$/.test(t) && !header.some((h) => h.trim() === t)) {
    let n = 0;
    for (const ch of t.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  return header.findIndex((h) => norm(h) === norm(t));
}

function toText(v: Val): string {
  return v === undefined ? '' : String(v);
}

function looseNumber(v: Val): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const t = v.replace(/\s/g, '');
  if (!t || !/^-?[\d.,]+$/.test(t)) return undefined;
  // «1.234,5» (coma decimal) o «1234.5».
  const n = Number(
    /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''),
  );
  return Number.isFinite(n) ? n : undefined;
}

function dateOf(v: Val, formats: Array<'M/D/Y' | 'D/M/Y'> = []): string | undefined {
  const t = toText(v).trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const fmt = formats[0];
    const [mo, d] = fmt === 'D/M/Y' ? [b, a] : fmt === 'M/D/Y' ? [a, b] : [0, 0];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (fmt) return undefined;
  }
  return dayOfCell(t) ?? undefined;
}

function regex(pattern: string, flags?: string): RegExp {
  return new RegExp(pattern, flags);
}

export function applyOp(v: Val, op: Op): Val {
  switch (op.op) {
    case 'text': {
      const t = toText(v).replace(/\s+/g, ' ').trim();
      return t ? t : undefined;
    }
    case 'trim': {
      const t = toText(v).trim();
      return t ? t : undefined;
    }
    case 'upper':
      return v === undefined ? v : toText(v).toUpperCase();
    case 'lower':
      return v === undefined ? v : toText(v).toLowerCase();
    case 'digits': {
      const d = toText(v).replace(/\D/g, '');
      return d || undefined;
    }
    case 'number':
      return looseNumber(v);
    case 'round': {
      const n = looseNumber(v);
      if (n === undefined) return undefined;
      const f = 10 ** op.digits;
      return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
    }
    case 'date':
      return dateOf(v, op.formats);
    case 'replace': {
      if (v === undefined) return v;
      const out = toText(v).replace(regex(op.pattern, op.flags), op.with);
      return out === '' ? undefined : out;
    }
    case 'extract': {
      if (v === undefined) return v;
      const m = regex(op.pattern, op.flags).exec(toText(v));
      const g = m?.[op.group];
      return g ? g : undefined;
    }
    case 'map': {
      if (v === undefined) return v;
      const key = op.normalize ? norm(toText(v)) : toText(v);
      for (const [k, to] of Object.entries(op.table)) {
        if ((op.normalize ? norm(k) : k) === key) return to;
      }
      return op.unmapped === 'empty' ? undefined : v;
    }
    case 'test':
      return regex(op.pattern, op.flags).test(toText(v)) ? op.then : op.else;
    case 'default':
      return v === undefined ? op.value : v;
  }
}

function cellVal(cell: SheetValue | undefined): Val {
  if (cell === null || cell === undefined) return undefined;
  if (typeof cell === 'boolean') return cell ? 'Sí' : 'No';
  if (typeof cell === 'number') return cell;
  const t = String(cell).trim();
  // Un error de fórmula de Excel no es un dato.
  return !t || /^#(REF|N\/A|VALUE|DIV\/0|NAME|NUM|NULL)/.test(t) ? undefined : t;
}

function test(cond: Cond, vars: Record<string, Val>): boolean {
  const v = vars[cond.var];
  let ok: boolean;
  if (cond.empty !== undefined) ok = (v === undefined || v === '') === cond.empty;
  else {
    const list = Array.isArray(cond.equals) ? cond.equals : [cond.equals as string | number];
    ok = v !== undefined && list.some((x) => String(x) === String(v));
  }
  return cond.not ? !ok : ok;
}

function render(template: string, ctx: Record<string, Val>): string | null {
  let missing = false;
  const out = template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_m, k: string) => {
    const v = ctx[k];
    if (v === undefined || v === '') {
      missing = true;
      return '';
    }
    return String(v);
  });
  return missing ? null : out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface LookupRow {
  id: string;
  label: string;
  values: Record<string, unknown>;
}
export type Lookups = Record<string, LookupRow[]>;

export interface PlannedChild {
  key: string;
  line: number;
  parentKey: string;
  /** Campo → valor listo (relaciones ya como JSON {id,label}). */
  values: Record<string, string | number>;
  /** Campos que sólo se escriben al crear / que se respetan según el valor actual. */
  insertOnly: string[];
  keepIf: Record<string, string[]>;
}

export interface PlannedParent {
  key: string;
  values: Record<string, string | number>;
  insertOnly: string[];
  keepIf: Record<string, string[]>;
  childCount: number;
  chargeCount: number;
}

export interface GroupedPlan {
  children: PlannedChild[];
  parents: PlannedParent[];
  /** Filas que no entraron, por motivo. */
  skipped: Record<string, number>;
  /** Valores de la hoja que no encontraron su fila en una tabla relacionada. */
  unresolved: Record<string, Record<string, number>>;
  missingColumns: string[];
}

function lookupIndex(rows: LookupRow[], by: string, numeric: boolean) {
  const idx = new Map<string, LookupRow>();
  for (const r of rows) {
    const raw = by === 'label' ? r.label : r.values[by];
    if (raw === undefined || raw === null || raw === '') continue;
    const key = numeric ? String(Number(raw)) : norm(String(raw));
    if (!idx.has(key)) idx.set(key, r);
  }
  return idx;
}

export function planGrouped(sheet: SheetData, spec: SheetSpec, lookups: Lookups): GroupedPlan {
  const header = (sheet.rows[spec.headerRows - 1] ?? []).map((h) => String(h ?? '').trim());
  const missingColumns: string[] = [];
  const cols = new Map<string, number>();
  const varNames = Object.keys(spec.vars);
  for (const [name, v] of Object.entries(spec.vars)) {
    if (v.from.startsWith('$')) continue;
    const i = colIndex(v.from, header);
    if (i < 0) missingColumns.push(v.from);
    else cols.set(name, i);
  }
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const unresolved: Record<string, Record<string, number>> = {};

  const rels = Object.entries(spec.child.relations).map(([field, r]) => ({
    field,
    r,
    idx: lookupIndex(lookups[r.tracker] ?? [], r.by, r.numeric),
  }));

  const body = sheet.rows.slice(spec.headerRows, spec.headerRows + spec.rowCap);
  const seenKeys = new Map<string, number>();
  const children: PlannedChild[] = [];
  const groups = new Map<string, { rows: Array<Record<string, Val>>; charges: Array<Record<string, Val>> }>();

  body.forEach((row, i) => {
    const line = spec.headerRows + i + 1;
    if (!row.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) return;
    const vars: Record<string, Val> = {};
    for (const name of varNames) {
      const def = spec.vars[name] as (typeof spec.vars)[string];
      let v: Val = def.from.startsWith('$')
        ? vars[def.from.slice(1)]
        : cellVal(row[cols.get(name) ?? -1]);
      for (const op of def.ops) v = applyOp(v, op);
      vars[name] = v;
    }
    const groupKey = spec.parent ? vars[spec.parent.groupVar] : undefined;
    const isCharge = spec.chargeWhen.length > 0 && spec.chargeWhen.every((c) => test(c, vars));
    if (isCharge) {
      if (spec.parent && groupKey !== undefined) {
        const g = groups.get(String(groupKey)) ?? { rows: [], charges: [] };
        g.charges.push(vars);
        groups.set(String(groupKey), g);
      } else skip('cargo sin grupo');
      return;
    }
    if (!spec.rowWhen.every((c) => test(c, vars))) return skip('no es fila de datos');
    if (spec.parent && groupKey === undefined) return skip('sin valor de grupo');
    let key = render(spec.child.key, vars);
    if (!key) return skip('sin clave');
    const n = (seenKeys.get(key) ?? 0) + 1;
    seenKeys.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    key = key.slice(0, MAX);

    const values: Record<string, string | number> = {};
    const insertOnly: string[] = [];
    const keepIf: Record<string, string[]> = {};
    for (const [field, src] of Object.entries(spec.child.fields)) {
      const v = 'const' in src ? src.const : vars[src.var];
      if (v === undefined || v === '') continue;
      values[field] = v;
      if (src.on === 'insert') insertOnly.push(field);
      if ('keepIf' in src && src.keepIf?.length) keepIf[field] = src.keepIf;
    }
    for (const { field, r, idx } of rels) {
      const raw = vars[r.var];
      if (raw === undefined || raw === '') continue;
      const found = idx.get(r.numeric ? String(Number(raw)) : norm(String(raw)));
      if (!found) {
        const u = (unresolved[field] ??= {});
        u[String(raw)] = (u[String(raw)] ?? 0) + 1;
        continue;
      }
      values[field] = JSON.stringify({ id: found.id, label: found.label });
      if (r.on === 'insert') insertOnly.push(field);
    }
    if (spec.parent) {
      const g = groups.get(String(groupKey)) ?? { rows: [], charges: [] };
      g.rows.push(vars);
      groups.set(String(groupKey), g);
    }
    const parentKey = spec.parent
      ? (render(spec.parent.key, { [spec.parent.groupVar]: groupKey }) ?? '')
      : '';
    children.push({ key, line, parentKey, values, insertOnly, keepIf });
  });

  const parents: PlannedParent[] = [];
  if (spec.parent) {
    for (const [gk, g] of groups) {
      const key = render(spec.parent.key, { ...Object.fromEntries([[spec.parent.groupVar, gk]]) });
      if (!key) continue;
      const values: Record<string, string | number> = {};
      const insertOnly: string[] = [];
      const keepIf: Record<string, string[]> = {};
      const derived: Array<[string, z.infer<typeof deriveSchema>]> = [];
      for (const [field, def] of Object.entries(spec.parent.fields)) {
        if ('derive' in def) {
          derived.push([field, def]);
          continue;
        }
        if ('const' in def) {
          values[field] = def.const;
          if (def.on === 'insert') insertOnly.push(field);
          continue;
        }
        if (!('agg' in def)) {
          const v = g.rows[0]?.[def.var];
          if (v !== undefined && v !== '') values[field] = v;
          if (def.on === 'insert') insertOnly.push(field);
          if (def.keepIf?.length) keepIf[field] = def.keepIf;
          continue;
        }
        const pool = def.rows === 'child' ? g.rows : def.rows === 'charge' ? g.charges : [...g.rows, ...g.charges];
        const list = pool.map((r) => r[def.var]).filter((x): x is string | number => x !== undefined && x !== '');
        let out: string | number | undefined;
        if (def.agg === 'first') out = list[0];
        else if (def.agg === 'distinct') {
          const u = [...new Set(list.map(String))];
          out = u.length ? u.join(def.sep).slice(0, 4000) : undefined;
        } else if (def.agg === 'sum') {
          const nums = list.map(Number).filter(Number.isFinite);
          out = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100 : undefined;
        } else if (def.agg === 'max') {
          const nums = list.map(Number).filter(Number.isFinite);
          out = nums.length ? Math.max(...nums) : undefined;
        } else if (def.agg === 'allEqual') {
          out = pool.length && pool.every((r) => String(r[def.var] ?? '') === def.equals) ? def.equals : def.else;
        }
        if (out === undefined) continue;
        values[field] = out;
        if (def.on === 'insert') insertOnly.push(field);
        if (def.keepIf?.length) keepIf[field] = def.keepIf;
      }
      for (const [field, def] of derived) {
        const ctx: Record<string, Val> = { ...values, [spec.parent.groupVar]: gk, key: gk };
        for (const rule of def.derive) {
          const ok = (rule.when ?? []).every((w) =>
            w.empty !== undefined
              ? (ctx[w.field] === undefined || ctx[w.field] === '') === w.empty
              : String(ctx[w.field] ?? '') === String(w.equals),
          );
          if (!ok) continue;
          const out = render(rule.value, ctx);
          if (out) {
            values[field] = out.slice(0, MAX);
            if (def.on === 'insert') insertOnly.push(field);
          }
          break;
        }
      }
      parents.push({ key, values, insertOnly, keepIf, childCount: g.rows.length, chargeCount: g.charges.length });
    }
  }
  return { children, parents, skipped, unresolved, missingColumns };
}

// ---------------------------------------------------------------------------
// Comparación con lo que ya hay
// ---------------------------------------------------------------------------

export interface ExistingRow {
  id: string;
  external_key: string;
  values: Record<string, unknown>;
  updated_at: string;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface RowDiff {
  key: string;
  action: 'insert' | 'update' | 'unchanged';
  changes: FieldChange[];
  /** Escrituras que sí se harían (ya sin lo insert-only ni lo que se respeta). */
  write: Record<string, string | number>;
  conflict: boolean;
  existingId?: string;
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === undefined || a === null || a === '') return b === undefined || b === null || b === '';
  if (b === undefined || b === null || b === '') return false;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== 'object' && typeof b !== 'object' && !Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '')
    return na === nb;
  const rel = (x: unknown) => {
    try {
      const o = typeof x === 'string' ? JSON.parse(x) : x;
      return o && typeof o === 'object' && 'id' in o ? String((o as { id: unknown }).id) : null;
    } catch {
      return null;
    }
  };
  const ra = rel(a);
  const rb = rel(b);
  if (ra && rb) return ra === rb;
  return String(a) === String(b);
};

/**
 * Qué pasaría con una fila planeada frente a la que existe. «Conflicto»: la
 * fila cambió en la app después de `since` y alguno de los campos que la hoja
 * escribe difiere (la hoja gana, y el conflicto se reporta).
 */
export function diffRow(
  planned: Pick<PlannedChild, 'key' | 'values' | 'insertOnly' | 'keepIf'>,
  existing: ExistingRow | undefined,
  since: string | null,
): RowDiff {
  if (!existing)
    return { key: planned.key, action: 'insert', changes: [], write: { ...planned.values }, conflict: false };
  const changes: FieldChange[] = [];
  const write: Record<string, string | number> = {};
  for (const [field, after] of Object.entries(planned.values)) {
    if (planned.insertOnly.includes(field)) continue;
    const current = existing.values[field];
    const guard = planned.keepIf[field];
    if (guard && current !== undefined && guard.includes(String(current))) continue;
    if (same(current, after)) continue;
    changes.push({ field, before: shortValue(current), after: shortValue(after) });
    write[field] = after;
  }
  const touched = since !== null && Date.parse(existing.updated_at) > Date.parse(since);
  return {
    key: planned.key,
    action: changes.length ? 'update' : 'unchanged',
    changes,
    write,
    conflict: touched && changes.length > 0,
    existingId: existing.id,
  };
}

function shortValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v) as { label?: unknown };
      if (o && typeof o === 'object' && 'label' in o) return String(o.label);
    } catch {
      /* texto normal */
    }
    return v.slice(0, 80);
  }
  return String(v);
}

/** Prefijo fijo de una plantilla de clave («import2026:m:{n}» → «import2026:m:»). */
export function keyPrefix(template: string): string {
  const i = template.indexOf('{');
  return i < 0 ? template : template.slice(0, i);
}
