import type { SupabaseClient } from '@supabase/supabase-js';
import { getDuplicateRule, normalizeDuplicateKey } from './duplicates';
import type { TrackerField } from './schema';

/**
 * «PARECE QUE YA EXISTE»: la verificación PREVIA al guardar.
 *
 * La regla de duplicados (0201) marca DESPUÉS de guardar; esto avisa ANTES, con
 * la misma clave, para que la persona abra la fila que ya está en vez de crear
 * otra. Es un aviso, nunca un bloqueo (el bloqueo duro es el campo «único»).
 *
 * Qué se compara:
 *   - si la tabla tiene regla de duplicados, su campo clave (sin espacios,
 *     guiones ni mayúsculas: «045-123» y «045123» son la misma guía);
 *   - si no, el nombre que la persona escribe a mano (el campo de texto que da
 *     nombre a la fila), sin tildes ni mayúsculas. Una fila cuyo nombre sale de
 *     una relación (la atención de un vuelo) no se compara: repetirse es normal.
 *
 * Archivo con una parte pura (qué campo, cuándo coincide) y una lectura corta
 * a la base. Quien llama filtra por lo que el rol puede ver.
 */

export interface DuplicateCandidate {
  id: string;
  label: string;
  /** Por qué se parecen: «Guía: 045-1234». */
  why: string;
  /** Lo que tiene guardado (para quien llama; no viaja tal cual al navegador). */
  values: Record<string, unknown>;
  updatedAt: string;
  createdBy?: string | null;
  createdByApp?: string | null;
}

export interface DuplicateCheck {
  /** Campos que miró (para que el navegador sólo vuelva a preguntar si cambian). */
  keys: string[];
  matches: DuplicateCandidate[];
}

const fold = (t: unknown) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // «AV 2041», «av-2041» y «AV2041» son el mismo nombre.
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** El campo de texto que da nombre a la fila cuando lo escribe una persona; null si no hay. */
export function nameFieldOf(fields: readonly TrackerField[]): TrackerField | null {
  const hand = (f: TrackerField) => f.type === 'text' && !f.formula && f.default !== 'viewer';
  return fields.find((f) => hand(f) && f.required) ?? fields.find(hand) ?? null;
}

/** Los campos y cómo se comparan, según la tabla. */
export function duplicateKeyFor(
  fields: readonly TrackerField[],
  ruleKey: string | null,
): { field: TrackerField; mode: 'key' | 'name' } | null {
  if (ruleKey) {
    const f = fields.find((x) => x.key === ruleKey);
    if (f) return { field: f, mode: 'key' };
  }
  const name = nameFieldOf(fields);
  return name ? { field: name, mode: 'name' } : null;
}

/** ¿Estos dos valores son «el mismo» para este modo? */
export function sameForDuplicates(mode: 'key' | 'name', a: unknown, b: unknown): boolean {
  if (mode === 'key') {
    const x = normalizeDuplicateKey(a);
    return x !== '' && x === normalizeDuplicateKey(b);
  }
  const x = fold(a);
  return x.length >= 2 && x === fold(b);
}

/** `%a%b%c%` para que la base traiga variantes con espacios o guiones de por medio. */
function looseLike(value: string): string {
  const chars = [...value.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 40);
  return `%${chars.map((c) => c.replace(/[%_\\]/g, '')).join('%')}%`;
}

export async function findLikelyDuplicates(
  db: SupabaseClient,
  tracker: { id: string; fields: TrackerField[] },
  values: Record<string, unknown>,
  options: {
    selfId?: string;
    limit?: number;
    /** La clave de la regla de duplicados si quien llama ya la leyó (`null` = no tiene); sin esto se lee aquí. */
    ruleKey?: string | null;
  } = {},
): Promise<DuplicateCheck> {
  const ruleKey =
    options.ruleKey !== undefined
      ? options.ruleKey
      : ((await getDuplicateRule(db, tracker.id))?.rule.key ?? null);
  const key = duplicateKeyFor(tracker.fields, ruleKey);
  if (!key) return { keys: [], matches: [] };
  const keys = [key.field.key];
  const mine = values[key.field.key];
  const text = String(mine ?? '').trim();
  const enough = key.mode === 'key' ? normalizeDuplicateKey(mine).length >= 3 : text.length >= 3;
  if (!enough) return { keys, matches: [] };

  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, updated_at, created_by, created_by_app_user')
    .eq('tracker_id', tracker.id)
    .ilike(`values->>${key.field.key}`, looseLike(text))
    .order('updated_at', { ascending: false })
    .limit(40);
  if (error) return { keys, matches: [] };
  const matches: DuplicateCandidate[] = [];
  for (const r of (data ?? []) as Array<{
    id: string;
    label: string;
    values: Record<string, unknown> | null;
    updated_at: string;
    created_by?: string | null;
    created_by_app_user?: string | null;
  }>) {
    if (options.selfId && r.id === options.selfId) continue;
    if (!sameForDuplicates(key.mode, r.values?.[key.field.key], mine)) continue;
    matches.push({
      id: r.id,
      label: String(r.label || 'Sin nombre'),
      why: `${key.field.label}: ${String(r.values?.[key.field.key] ?? '').trim()}`,
      values: r.values ?? {},
      updatedAt: r.updated_at,
      ...(r.created_by !== undefined ? { createdBy: r.created_by ?? null } : {}),
      ...(r.created_by_app_user !== undefined ? { createdByApp: r.created_by_app_user ?? null } : {}),
    });
    if (matches.length >= (options.limit ?? 3)) break;
  }
  return { keys, matches };
}

/** La frase para el chat: «Ya existe «Acme» (Nombre: Acme). No la creé de nuevo.» */
export function duplicateSentence(matches: readonly DuplicateCandidate[]): string {
  const first = matches[0];
  if (!first) return '';
  const more = matches.length > 1 ? ` y ${matches.length - 1} más parecida${matches.length > 2 ? 's' : ''}` : '';
  return `Ya existe «${first.label}» (${first.why})${more}`;
}
