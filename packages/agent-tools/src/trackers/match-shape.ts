import { compilePattern, isSafePattern } from './formats';

/**
 * «BUSCAR EN UNA LISTA»: UN CAMPO QUE SE LLENA SIN IA.
 *
 * Un campo con `match` toma un campo disparador (`from`), lo normaliza
 * (mayúsculas, sin espacios, guiones, puntos ni tildes), extrae la clave (el
 * valor completo, un prefijo de N letras o el grupo de una regex) y la busca en
 * una tabla de referencia —cualquier tabla del espacio por un campo clave, o una
 * lista de la plataforma como `cortex.aerolineas`—. Si la encuentra, propone
 * valores para uno o varios campos destino con las columnas de esa fila.
 *
 * Es instantáneo (corre en el navegador sobre las filas que el bloque ya trae,
 * por eso funciona sin señal con la caché de pantallas) y NUNCA pisa lo que la
 * persona escribió: las sugerencias pasan por el mismo `mergeSuggestions` del
 * autofill con Cortex. Puro y sin dependencias de servidor.
 *
 * CASCADA: un campo puede tener `match` y además `autofill` (Cortex). Por omisión
 * Cortex sólo corre si NO hubo coincidencia (`when: 'no_match'`); con
 * `when: 'rest'` Cortex completa los destinos que la lista no llenó (fecha y hora
 * del vuelo cuando la lista sólo sabe la aerolínea).
 */

export type MatchExtract =
  | { mode: 'full' }
  | { mode: 'prefix'; length: number }
  | { mode: 'regex'; pattern: string };

export interface MatchConfig {
  /** El campo disparador (puede ser el propio). */
  from: string;
  extract?: MatchExtract;
  /** `cortex.aerolineas` o el slug de una tabla del espacio. */
  source: string;
  /** La columna / campo de la fuente donde está la clave. */
  key: string;
  /** campo destino de este formulario → columna de la fuente. */
  fills: Record<string, string>;
}

/** Las filas de la fuente que viajan con el bloque: sólo las columnas que se usan. */
export interface MatchTable {
  key: string;
  rows: Array<Record<string, string>>;
}

export const MATCH_MAX_FILLS = 8;

/** MAYÚSCULAS, sin tildes, sin espacios, guiones, puntos, guiones bajos ni diagonales. */
export function normalizeMatchText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[\s\-_.\/\\]+/g, '');
}

/** La clave que se busca, o null si el valor no la tiene (vacío, muy corto, regex sin coincidencia). */
export function extractMatchKey(extract: MatchExtract | undefined, raw: unknown): string | null {
  const text = normalizeMatchText(raw);
  if (!text) return null;
  const mode = extract?.mode ?? 'full';
  if (mode === 'full') return text;
  if (mode === 'prefix') {
    const n = (extract as { length: number }).length;
    return text.length >= n ? text.slice(0, n) : null;
  }
  const pattern = (extract as { pattern: string }).pattern;
  if (!isSafePattern(pattern)) return null;
  const re = compilePattern(pattern);
  if (!re) return null;
  const m = re.exec(text);
  if (!m) return null;
  const picked = m[1] ?? m[0];
  return picked ? normalizeMatchText(picked) : null;
}

/** Clave normalizada → fila. La primera que aparece gana. */
export function buildMatchIndex(table: MatchTable): Map<string, Record<string, string>> {
  const index = new Map<string, Record<string, string>>();
  for (const row of table.rows) {
    const k = normalizeMatchText(row[table.key]);
    if (k && !index.has(k)) index.set(k, row);
  }
  return index;
}

const indexCache = new WeakMap<MatchTable, Map<string, Record<string, string>>>();
function indexOf(table: MatchTable) {
  let index = indexCache.get(table);
  if (!index) {
    index = buildMatchIndex(table);
    indexCache.set(table, index);
  }
  return index;
}

export interface MatchOutcome {
  /** ¿Se encontró la clave en la lista? */
  hit: boolean;
  /** La clave que se buscó (null = el disparador aún no la tiene). */
  key: string | null;
  /** Destino → valor, sólo lo que la fila tiene. */
  suggestions: Record<string, { value: string; source: string }>;
}

export function runMatch(
  config: MatchConfig,
  table: MatchTable | undefined,
  values: Record<string, unknown>,
): MatchOutcome {
  const key = extractMatchKey(config.extract, values[config.from]);
  if (!key || !table) return { hit: false, key, suggestions: {} };
  const row = indexOf(table).get(key);
  if (!row) return { hit: false, key, suggestions: {} };
  const suggestions: MatchOutcome['suggestions'] = {};
  for (const [target, column] of Object.entries(config.fills)) {
    const v = row[column];
    if (typeof v === 'string' && v.trim())
      suggestions[target] = { value: v.trim(), source: config.source };
  }
  return { hit: true, key, suggestions };
}

export type CascadeWhen = 'no_match' | 'rest';

/**
 * Los destinos que Cortex debe llenar tras intentar la lista. Vacío = no hace
 * falta llamarlo. `matched` son los destinos que la lista SÍ llenó.
 */
export function cortexTargetsAfterMatch(
  autofillFills: readonly string[],
  when: CascadeWhen | undefined,
  outcome: Pick<MatchOutcome, 'hit'> & { matched: readonly string[] },
): string[] {
  if (!outcome.hit) return [...autofillFills];
  if (when === 'rest') return autofillFills.filter((k) => !outcome.matched.includes(k));
  return [];
}

/** Las fuentes distintas que usan los campos (para traer sus filas). */
export function matchSourcesOf(
  fields: ReadonlyArray<{ match?: MatchConfig }>,
): Array<{ source: string; columns: string[] }> {
  const by = new Map<string, Set<string>>();
  for (const f of fields) {
    if (!f.match) continue;
    const cols = by.get(f.match.source) ?? new Set<string>();
    cols.add(f.match.key);
    for (const c of Object.values(f.match.fills)) cols.add(c);
    by.set(f.match.source, cols);
  }
  return [...by.entries()].map(([source, columns]) => ({ source, columns: [...columns] }));
}

/** Filas de la fuente (cualquier forma) → sólo las columnas usadas, como texto. */
export function toMatchTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  key: string,
  columns: readonly string[],
  cap = 3000,
): MatchTable {
  const out: MatchTable['rows'] = [];
  for (const r of rows) {
    if (out.length >= cap) break;
    if (r[key] === undefined || r[key] === null || String(r[key]).trim() === '') continue;
    out.push(
      Object.fromEntries(
        columns.flatMap((c) =>
          r[c] === undefined || r[c] === null || r[c] === '' ? [] : [[c, String(r[c])]],
        ),
      ),
    );
  }
  return { key, rows: out };
}
