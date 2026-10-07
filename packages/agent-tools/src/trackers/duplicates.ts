import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { emitAutomationEvent, watchesTracker } from '../apps/automations/emit';
import { FIELD_KEY_RE, type TrackerField, trackerFieldsSchema } from './schema';

/**
 * La regla de duplicados de una tabla (migración 0201).
 *
 * Caso de uso: guías aéreas (AWB) que llegan del cliente. Si el MISMO número
 * de guía aparece con una fecha distinta, alguien se equivocó al teclear una
 * de las dos y hay que corregirla ANTES de despachar. La regla marca TODAS las
 * filas del conflicto —no sólo la nueva: no se sabe cuál es la equivocada— con
 * un valor en un campo de estado, y las desmarca sola cuando el conflicto se
 * resuelve.
 *
 * Dos capas, a propósito:
 *   - `computeDuplicateFlags`: función PURA (filas entran, decisiones salen).
 *     Es donde vive la lógica y lo que se prueba.
 *   - `applyDuplicateRule`: lee, llama a la pura y escribe. Es el ÚNICO lugar
 *     que toca las marcas; cada camino de escritura de filas la llama después
 *     de escribir (upsertRow, vistas, sync de Drive).
 *
 * «Sólo se quita la marca si la puso la regla»: cada fila lleva
 * `tracker_rows.duplicate_flagged`. Una fila que alguien dejó en «Duplicada» a
 * mano tiene la bandera en false y la regla no la toca al desmarcar.
 */

export const duplicateRuleSchema = z.object({
  key: z.string().regex(FIELD_KEY_RE).describe('Campo cuyo valor no debe repetirse.'),
  distinctBy: z
    .string()
    .regex(FIELD_KEY_RE)
    .optional()
    .describe('Sólo es conflicto si este campo difiere entre las filas que repiten la clave.'),
  flagField: z.string().regex(FIELD_KEY_RE).describe('Campo (select o texto) donde se marca.'),
  flagValue: z.string().trim().min(1).max(80).default('Duplicada'),
});
export type DuplicateRule = z.infer<typeof duplicateRuleSchema>;

/** Qué le falta a la regla para ser válida sobre estos campos; null si está bien. */
export function validateDuplicateRule(rule: DuplicateRule, fields: TrackerField[]): string | null {
  const by = (k: string) => fields.find((f) => f.key === k);
  if (!by(rule.key)) return `El campo clave «${rule.key}» no existe en la tabla.`;
  if (rule.distinctBy && !by(rule.distinctBy))
    return `El campo «${rule.distinctBy}» (distinctBy) no existe en la tabla.`;
  const flag = by(rule.flagField);
  if (!flag) return `El campo de marca «${rule.flagField}» no existe en la tabla.`;
  if (flag.key === rule.key || flag.key === rule.distinctBy)
    return 'El campo de marca tiene que ser distinto de la clave y de distinctBy.';
  if (flag.type === 'select') {
    if (!flag.options?.includes(rule.flagValue))
      return `«${flag.label}» no tiene la opción «${rule.flagValue}»; agrégala a sus opciones.`;
  } else if (flag.type !== 'text') {
    return `El campo de marca tiene que ser de opciones o de texto, no ${flag.type}.`;
  }
  return null;
}

/** «045-123 456» y «045123456» son la misma guía: sin espacios ni guiones, en mayúsculas. */
export function normalizeDuplicateKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[\s\-_.]+/g, '');
}

export interface DuplicateInputRow {
  id: string;
  values: Record<string, unknown>;
  /** ¿La marca actual la puso la regla? (`tracker_rows.duplicate_flagged`) */
  flagged: boolean;
}

export interface DuplicateConflict {
  rowId: string;
  /** La clave normalizada del conflicto. */
  key: string;
  /** El valor de la clave como lo escribió esta fila, para mostrarlo. */
  value: string;
  /** Valores de `distinctBy` de las OTRAS filas del grupo (sin repetir, sin vacíos). */
  others: string[];
}

export interface DuplicateDecision {
  /** Filas que deben quedar marcadas (nuevas marcas y las que hay que re-marcar). */
  flag: string[];
  /** Filas cuya marca puso la regla y el conflicto ya no existe. */
  unflag: string[];
  /** Todas las filas hoy en conflicto, con contra qué chocan. */
  conflicts: DuplicateConflict[];
}

/**
 * Decide qué marcar y qué desmarcar. `only` limita las decisiones a esas claves
 * normalizadas (un envío toca una guía, no hace falta revisar las demás); sin
 * él se revisa toda la tabla. Un grupo es conflicto si tiene 2+ filas y, con
 * `distinctBy`, 2+ valores distintos de ese campo (una fila sin valor cuenta
 * como «sin fecha», distinta de una con fecha).
 */
export function computeDuplicateFlags(
  rule: DuplicateRule,
  rows: DuplicateInputRow[],
  only?: ReadonlySet<string>,
): DuplicateDecision {
  const groups = new Map<string, DuplicateInputRow[]>();
  for (const row of rows) {
    const key = normalizeDuplicateKey(row.values[rule.key]);
    if (!key) continue;
    if (only && !only.has(key)) continue;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const distinct = (row: DuplicateInputRow): string =>
    rule.distinctBy ? String(row.values[rule.distinctBy] ?? '').trim() : row.id;

  const decision: DuplicateDecision = { flag: [], unflag: [], conflicts: [] };
  const inConflict = new Set<string>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    if (new Set(group.map(distinct)).size < 2) continue;
    for (const row of group) {
      inConflict.add(row.id);
      const mine = distinct(row);
      const others = rule.distinctBy
        ? [...new Set(group.map(distinct).filter((d) => d && d !== mine))]
        : [];
      decision.conflicts.push({
        rowId: row.id,
        key,
        value: String(row.values[rule.key] ?? '').trim(),
        others,
      });
    }
  }

  for (const row of rows) {
    const key = normalizeDuplicateKey(row.values[rule.key]);
    // Con `only`, las filas de otras guías no se tocan; una sin clave sí se
    // revisa: si la regla la había marcado, ya no tiene con qué chocar.
    if (only && key && !only.has(key)) continue;
    const mark = String(row.values[rule.flagField] ?? '') === rule.flagValue;
    if (inConflict.has(row.id)) {
      if (!mark || !row.flagged) decision.flag.push(row.id);
    } else if (row.flagged) {
      decision.unflag.push(row.id);
    }
  }
  return decision;
}

/** Qué quedó de la fila `rowId` tras aplicar la regla, para avisar a quien la envió. */
export interface DuplicateOutcome {
  /** Filas que cambiaron de marca en esta pasada. */
  changed: number;
  conflicts: DuplicateConflict[];
  /** Filas que quedaron marcadas ahora (no lo estaban): disparan `row_flagged_duplicate`. */
  flagged?: string[];
}

export async function getDuplicateRule(
  db: SupabaseClient,
  trackerId: string,
): Promise<{ rule: DuplicateRule; fields: TrackerField[] } | null> {
  // Una lectura aparte, y que tolera la columna ausente (la migración 0201 aún
  // sin aplicar): sin regla, nada que hacer; nunca tumba una escritura.
  const { data, error } = await db
    .from('trackers')
    .select('duplicates, fields')
    .eq('id', trackerId)
    .maybeSingle();
  if (error || !data) return null;
  const raw = (data as { duplicates?: unknown }).duplicates;
  if (!raw) return null;
  const rule = duplicateRuleSchema.safeParse(raw);
  const fields = trackerFieldsSchema.safeParse((data as { fields?: unknown }).fields);
  if (!rule.success || !fields.success) return null;
  // Una regla que dejó de ser válida (borraron el campo) no marca nada.
  if (validateDuplicateRule(rule.data, fields.data)) return null;
  return { rule: rule.data, fields: fields.data };
}

/**
 * Lo que se tocó: el valor de la clave, o el objeto `values` de la fila (así
 * quien escribe no necesita saber cuál es el campo clave de la regla).
 */
export type TouchedKey = string | number | null | undefined | Record<string, unknown>;

const PAGE = 1000;
const MAX_ROWS = 20_000;
const WRITE_CHUNK = 20;

/**
 * Aplica la regla de la tabla. `touchedKeys` son los valores (sin normalizar)
 * del campo clave de las filas que se acaban de escribir —incluidos los
 * VIEJOS si una edición cambió la clave—; sin ellos se revisa la tabla entera.
 * Nunca lanza: marcar duplicados no puede hacer fallar el guardado de la fila.
 */
export async function applyDuplicateRule(
  db: SupabaseClient,
  trackerId: string,
  touchedKeys?: TouchedKey[],
): Promise<DuplicateOutcome> {
  const empty: DuplicateOutcome = { changed: 0, conflicts: [] };
  try {
    const cfg = await getDuplicateRule(db, trackerId);
    if (!cfg) return empty;
    const { rule } = cfg;

    const only = touchedKeys
      ? new Set(
          touchedKeys
            .map((k) => normalizeDuplicateKey(k && typeof k === 'object' ? k[rule.key] : k))
            .filter(Boolean),
        )
      : undefined;
    if (only && only.size === 0) return empty;

    const rows: DuplicateInputRow[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await db
        .from('tracker_rows')
        .select('id, values, duplicate_flagged')
        .eq('tracker_id', trackerId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return empty;
      for (const r of data ?? []) {
        const row = r as { id: string; values: unknown; duplicate_flagged: boolean | null };
        rows.push({
          id: row.id,
          values:
            row.values && typeof row.values === 'object' && !Array.isArray(row.values)
              ? (row.values as Record<string, unknown>)
              : {},
          flagged: row.duplicate_flagged === true,
        });
      }
      if (!data || data.length < PAGE) break;
    }

    const decision = computeDuplicateFlags(rule, rows, only);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const writes: Array<() => Promise<unknown>> = [];

    for (const id of decision.flag) {
      const row = byId.get(id);
      if (!row) continue;
      const values = { ...row.values, [rule.flagField]: rule.flagValue };
      writes.push(async () =>
        db
          .from('tracker_rows')
          .update({ values, duplicate_flagged: true })
          .eq('id', id)
          .eq('tracker_id', trackerId),
      );
    }
    for (const id of decision.unflag) {
      const row = byId.get(id);
      if (!row) continue;
      // Si alguien ya cambió el estado a otra cosa (Despachada), se respeta:
      // sólo se borra la marca cuando sigue siendo la de la regla.
      const values = { ...row.values };
      if (String(values[rule.flagField] ?? '') === rule.flagValue) delete values[rule.flagField];
      writes.push(async () =>
        db
          .from('tracker_rows')
          .update({ values, duplicate_flagged: false })
          .eq('id', id)
          .eq('tracker_id', trackerId),
      );
    }
    for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
      await Promise.all(writes.slice(i, i + WRITE_CHUNK).map((w) => w()));
    }
    // Las que quedaron marcadas AHORA (no lo estaban) avisan a las automatizaciones
    // que miran esta tabla (0210). Es el punto único: lo cruzan el formulario, la
    // grilla, el chat y todas las sincronizaciones. Nunca lanza.
    const flagged = decision.flag.filter((id) => byId.get(id)?.flagged !== true);
    if (flagged.length && (await watchesTracker(db, trackerId))) {
      for (const id of flagged.slice(0, 50)) {
        const row = byId.get(id);
        if (!row) continue;
        await emitAutomationEvent(db, {
          kind: 'row_flagged_duplicate',
          trackerId,
          rowId: id,
          after: { ...row.values, [rule.flagField]: rule.flagValue } as Record<
            string,
            string | number
          >,
          actor: { kind: 'system' },
        });
      }
    }
    return { changed: writes.length, conflicts: decision.conflicts, flagged };
  } catch {
    return empty;
  }
}

/**
 * La frase para quien acaba de enviar la fila, o null si no quedó en conflicto.
 * «045-1234» ya existe con fecha 2026-03-04 — quedó marcada Duplicada.
 */
export function duplicateMessage(
  rule: DuplicateRule,
  fields: TrackerField[],
  conflict: DuplicateConflict | undefined,
): string | null {
  if (!conflict) return null;
  const by = rule.distinctBy ? fields.find((f) => f.key === rule.distinctBy)?.label : undefined;
  const where = conflict.others.length
    ? ` con ${(by ?? 'otro valor').toLowerCase()} ${conflict.others.join(' y ')}`
    : '';
  return `«${conflict.value}» ya existe${where} — quedó marcada ${rule.flagValue}.`;
}
