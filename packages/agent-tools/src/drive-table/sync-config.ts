import { type TrackerField, coerceValue } from '../trackers/schema';
import { matchDocType } from './doc-types';
import { type PathRule, pathValue } from './path-fields';
import type { ExtractField, FolderFile } from './plan';

/**
 * LO QUE UNA SINCRONIZACIÓN SABE HACER CON CADA ARCHIVO — la parte pura.
 *
 * La configuración se guarda en las columnas que ya existían (sin migración):
 *
 *   - `extract_fields`: cada entrada es un campo que se lee de un documento
 *     (`{key, hint}`), de un tipo de documento en particular (`docType`), o de
 *     la RUTA (`fromPath`: el nivel de subcarpeta y la pieza de su nombre).
 *   - `sheet_mapping`: campo → encabezado de la hoja. La clave reservada
 *     `@tipos` lista (separados por coma) los tipos de documento a los que se
 *     aplica el mapeo; sin ella aplica a todas las hojas.
 *
 * Con ASIGNACIÓN POR TIPO (alguna entrada con `docType`, o `@tipos`) la tabla se
 * llena con varios tipos de documento: cada archivo se clasifica por su nombre
 * (doc-types.ts) y llena sólo los campos de su tipo; las filas se unen por la
 * clave. Un archivo de un tipo que nadie usa NO se descarga ni se lee.
 */

export const SHEET_TYPES_KEY = '@tipos';

export interface SyncConfig {
  /** Campos que se leen de documentos (sin los de la ruta). */
  extract: ExtractField[];
  /** Campos que salen del nombre de las subcarpetas. */
  pathFields: Array<{ key: string; rule: PathRule }>;
  /** Mapeo de hojas, sin la clave reservada. */
  mapping: Record<string, string>;
  /** Tipos de documento a los que se aplica el mapeo (null = todos). */
  sheetTypes: string[] | null;
  /** Todos los tipos que la tabla usa. */
  docTypes: string[];
  /** Hay asignación por tipo: las filas de los distintos tipos se unen por la clave. */
  byType: boolean;
}

export function syncConfigOf(sync: {
  extract_fields: ExtractField[];
  sheet_mapping?: Record<string, string> | null;
}): SyncConfig {
  const raw = sync.sheet_mapping ?? {};
  const sheetTypes = raw[SHEET_TYPES_KEY]
    ? raw[SHEET_TYPES_KEY]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : null;
  const mapping = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== SHEET_TYPES_KEY));
  const extract = sync.extract_fields.filter((e) => !e.fromPath);
  const pathFields = sync.extract_fields.flatMap((e) =>
    e.fromPath ? [{ key: e.key, rule: e.fromPath }] : [],
  );
  const docTypes = [
    ...new Set([...extract.flatMap((e) => (e.docType ? [e.docType] : [])), ...(sheetTypes ?? [])]),
  ];
  return { extract, pathFields, mapping, sheetTypes, docTypes, byType: docTypes.length > 0 };
}

export type FileRoute =
  | { kind: 'skip'; reason: string }
  | { kind: 'read'; sheet: boolean; extract: ExtractField[]; fileType: string | null };

/**
 * Qué se hace con este archivo: leerlo como hoja (sin modelo), leerlo con el
 * modelo con ESTOS campos, o saltarlo porque su tipo no lo usa la tabla.
 */
export function routeFile(
  cfg: SyncConfig,
  file: Pick<FolderFile, 'name' | 'mimeType'>,
  isSheetFile: boolean,
  tableKeys: Set<string>,
): FileRoute {
  const fileType = cfg.byType ? matchDocType(file.name, file.mimeType, cfg.docTypes) : null;
  const generic = cfg.extract.filter((e) => !e.docType && tableKeys.has(e.key));
  const typed = cfg.extract.filter(
    (e) => e.docType && fileType !== null && e.docType === fileType && tableKeys.has(e.key),
  );
  const hasMapping = Object.keys(cfg.mapping).length > 0;
  const sheetApplies =
    isSheetFile &&
    hasMapping &&
    (cfg.sheetTypes === null || (fileType !== null && cfg.sheetTypes.includes(fileType)));
  if (sheetApplies) return { kind: 'read', sheet: true, extract: [], fileType };
  const extract = [...generic, ...typed];
  if (cfg.byType && fileType === null && !extract.length)
    return { kind: 'skip', reason: 'Es un tipo de documento que esta tabla no usa; no lo leí.' };
  if (cfg.byType && !extract.length)
    return {
      kind: 'skip',
      reason: 'Este tipo de documento no llena ningún campo de la tabla; no lo leí.',
    };
  return { kind: 'read', sheet: false, extract, fileType };
}

/**
 * Los valores de los campos de la ruta de un archivo. Lo que el nombre no trae
 * queda VACÍO y sale un motivo para revisar; nunca se inventa.
 */
export function pathFieldValues(
  cfg: SyncConfig,
  path: string,
  fields: TrackerField[],
): { values: Record<string, string | number>; review: string[] } {
  const values: Record<string, string | number> = {};
  const review: string[] = [];
  for (const { key, rule } of cfg.pathFields) {
    const field = fields.find((f) => f.key === key);
    if (!field) continue;
    const raw = pathValue(path, rule);
    if (raw === undefined) {
      const seg = path ? path.split(' / ')[rule.level - 1] : undefined;
      review.push(
        seg
          ? `«${field.label}»: el nombre de la carpeta «${seg}» no trae ese dato.`
          : `«${field.label}»: el archivo no está en una subcarpeta de nivel ${rule.level}.`,
      );
      continue;
    }
    const coerced = coerceValue(field, raw);
    if (!coerced.ok) {
      review.push(`«${field.label}»: ${coerced.message}`);
      continue;
    }
    if (coerced.value !== '') values[key] = coerced.value;
  }
  return { values, review };
}
