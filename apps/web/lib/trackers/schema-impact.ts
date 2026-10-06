import type { TrackerField } from '@cortex/agent-tools/src/trackers/schema';
import { typeChangeIsSafe } from './schema-editor';

/**
 * QUÉ ROMPE CAMBIAR EL ESQUEMA DE UNA TABLA, SIN BASE DE DATOS.
 *
 * Quitar un campo o cambiarle el tipo puede dejar sin sentido cosas que lo
 * usan: un bloque de una vista (una columna, un filtro, el eje de un gráfico),
 * la regla de duplicados, la columna clave de una sincronización. Aquí vive la
 * parte pura de esa pregunta; la parte que lee vistas y sincronizaciones es
 * `schema-actions.ts`.
 *
 * LA DECISIÓN (la más segura): si el cambio rompería una vista, una regla o una
 * sincronización, NO se guarda y se dice cuáles son. No se «arreglan solas» las
 * vistas quitándoles el campo: un gráfico al que se le borra el eje queda
 * distinto de lo que alguien armó, y editar a escondidas la vista de otra
 * persona es peor que pedirle un paso más a quien cambia la tabla. Lo que sí se
 * hace solo es lo que no pierde nada: quitar el campo del mapeo de una
 * sincronización y los «mostrar sólo si» que dependían de él.
 */

export interface SchemaDiff {
  removed: Array<{ key: string; label: string }>;
  retyped: Array<{ key: string; label: string; from: string; to: string }>;
  /** Opciones de un select que ya no están (las filas que las tienen quedan con un valor huérfano). */
  droppedOptions: Array<{ key: string; label: string; options: string[] }>;
}

export function diffSchemas(before: TrackerField[], after: TrackerField[]): SchemaDiff {
  const next = new Map(after.map((f) => [f.key, f]));
  const diff: SchemaDiff = { removed: [], retyped: [], droppedOptions: [] };
  for (const f of before) {
    const n = next.get(f.key);
    if (!n) {
      diff.removed.push({ key: f.key, label: f.label });
      continue;
    }
    if (n.type !== f.type)
      diff.retyped.push({ key: f.key, label: f.label, from: f.type, to: n.type });
    if (f.type === 'select' && n.type === 'select') {
      const gone = (f.options ?? []).filter((o) => !(n.options ?? []).includes(o));
      if (gone.length) diff.droppedOptions.push({ key: f.key, label: f.label, options: gone });
    }
  }
  return diff;
}

/** Los problemas que aparecen DESPUÉS del cambio y no estaban antes (lo que el cambio rompe). */
export function introducedProblems(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((p) => !had.has(p));
}

export interface ViewLike {
  id: string;
  slug: string;
  name: string;
  spec: unknown;
}

export interface ViewImpact {
  id: string;
  slug: string;
  name: string;
  problems: string[];
}

/**
 * Las vistas que el cambio deja con problemas. `check` es `checkSpecAgainst`
 * (inyectada: este archivo no importa el barril del servidor) y `catalogWith`
 * arma el catálogo con la tabla en uno u otro estado.
 */
export function viewsBroken<S>(
  views: Array<ViewLike & { spec: S }>,
  uses: (spec: S) => boolean,
  check: (spec: S, which: 'before' | 'after') => string[],
): ViewImpact[] {
  const out: ViewImpact[] = [];
  for (const v of views) {
    if (!uses(v.spec)) continue;
    const problems = introducedProblems(check(v.spec, 'before'), check(v.spec, 'after'));
    if (problems.length) out.push({ id: v.id, slug: v.slug, name: v.name, problems });
  }
  return out;
}

export interface SyncUse {
  kind: 'table_sync' | 'drive_folder';
  keyFields: string[];
}

/** Otro lugar que nombra un campo (p. ej. «Qué se mide» de Equipo). */
export interface FieldUse {
  key: string;
  where: string;
}

export interface DuplicateUse {
  key: string;
  distinctBy?: string;
  flagField: string;
}

/**
 * Lo que impide quitar o retipar estos campos aunque ninguna vista los use:
 * la columna clave de una sincronización (cambiaría la identidad de las filas
 * y la próxima vuelta las duplicaría) y los campos de la regla de duplicados.
 */
export function ruleBlockers(
  diff: SchemaDiff,
  syncs: SyncUse[],
  duplicates: DuplicateUse | null,
  extra: FieldUse[] = [],
): string[] {
  const gone = new Set([...diff.removed.map((r) => r.key), ...diff.retyped.map((r) => r.key)]);
  const label = new Map([...diff.removed, ...diff.retyped].map((r) => [r.key, r.label] as const));
  const out: string[] = [];
  for (const s of syncs) {
    for (const k of s.keyFields)
      if (gone.has(k))
        out.push(
          `«${label.get(k)}» es columna clave de una sincronización de ${s.kind === 'drive_folder' ? 'una carpeta de Drive' : 'una hoja'}. Cámbiale la clave antes de tocar el campo.`,
        );
  }
  if (duplicates) {
    for (const [role, k] of [
      ['el campo que no debe repetirse', duplicates.key],
      ['el campo «con distinto…»', duplicates.distinctBy],
      ['el campo donde se marca', duplicates.flagField],
    ] as const)
      if (k && gone.has(k))
        out.push(
          `«${label.get(k)}» es ${role} en la regla de duplicados. Cambia o quita la regla primero.`,
        );
  }
  for (const u of extra)
    if (gone.has(u.key))
      out.push(`«${label.get(u.key)}» lo usa ${u.where}. Cámbialo ahí antes de tocar el campo.`);
  return out;
}

/** Los cambios de tipo que NO son seguros cuando el campo ya tiene datos. */
export function unsafeRetypes(
  diff: SchemaDiff,
  withData: Record<string, number>,
): Array<{ key: string; label: string; from: string; to: string; rows: number }> {
  return diff.retyped
    .filter(
      (r) =>
        (withData[r.key] ?? 0) > 0 &&
        !typeChangeIsSafe(r.from as TrackerField['type'], r.to as TrackerField['type']),
    )
    .map((r) => ({ ...r, rows: withData[r.key] ?? 0 }));
}
