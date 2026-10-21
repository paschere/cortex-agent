/**
 * REDEFINIR UNA TABLA NUNCA QUITA CAMPOS POR OMISIÓN.
 *
 * `trackers.define` sobre una tabla que ya existe FUSIONA: los campos que
 * vienen se agregan o reemplazan (por su llave) y los demás se conservan tal
 * cual. Quitar uno exige nombrarlo en `removeFields`. Así una llamada que sólo
 * quería agregar un autofill no borra en silencio `estado`, `hora_real` y
 * `observaciones` (pasó el 2026-10-16 en GROUNDFLEX).
 *
 * Puro y sin dependencias: lo usan la herramienta, la tarjeta de aprobación y
 * las pruebas. Los campos se tratan como objetos opacos con `key`.
 */

export interface KeyedField {
  key: string;
  [prop: string]: unknown;
}

export interface FieldsMerge<F extends KeyedField> {
  /** La definición resultante: lo que había (en su orden) + lo nuevo al final. */
  fields: F[];
  added: string[];
  changed: string[];
  /** Llaves que había y siguen igual (no venían o venían idénticas). */
  kept: string[];
  /** Llaves que se quitan porque se pidió explícitamente. */
  removed: string[];
  /** Llaves de `removeFields` que la tabla no tenía. */
  unknownRemovals: string[];
}

/** Lo que una redefinición NO debe perder aunque el campo venga sin ello (se configura por otra herramienta). */
const PRESERVED_PROPS = ['flow'] as const;

function sameField(a: KeyedField, b: KeyedField): boolean {
  const clean = (f: KeyedField) =>
    JSON.stringify(
      Object.keys(f)
        .sort()
        .flatMap((k) => {
          const v = f[k];
          if (v === undefined || v === null || v === false || v === '') return [];
          if (Array.isArray(v) && v.length === 0) return [];
          return [[k, v]];
        }),
    );
  return clean(a) === clean(b);
}

export function mergeFields<F extends KeyedField>(
  existing: F[],
  incoming: F[],
  removeFields: readonly string[] = [],
): FieldsMerge<F> {
  const remove = new Set(removeFields);
  const incomingKeys = new Set(incoming.map((f) => f.key));
  const clash = [...remove].filter((k) => incomingKeys.has(k));
  if (clash.length)
    throw new Error(
      `«${clash.join('», «')}» viene en fields y también en removeFields: elige una de las dos.`,
    );
  const have = new Map(existing.map((f) => [f.key, f] as const));
  const added: string[] = [];
  const changed: string[] = [];
  const kept: string[] = [];
  const removed: string[] = [];
  const out: F[] = [];
  const unknownRemovals = [...remove].filter((k) => !have.has(k));

  for (const prior of existing) {
    if (remove.has(prior.key)) {
      removed.push(prior.key);
      continue;
    }
    const next = incoming.find((f) => f.key === prior.key);
    if (!next) {
      kept.push(prior.key);
      out.push(prior);
      continue;
    }
    const merged = { ...next } as F;
    for (const p of PRESERVED_PROPS)
      if (merged[p] === undefined && prior[p] !== undefined) (merged as KeyedField)[p] = prior[p];
    if (sameField(prior, merged)) kept.push(prior.key);
    else changed.push(prior.key);
    out.push(merged);
  }
  for (const f of incoming) {
    if (have.has(f.key)) continue;
    added.push(f.key);
    out.push(f);
  }
  return { fields: out, added, changed, kept, removed, unknownRemovals };
}
