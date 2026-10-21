import { ValidationError } from '@cortex/core';
import {
  type TrackerOrigin,
  creatingOrigin,
  fieldLockedMessage,
  hardOriginOfField,
  originName,
  originOfField,
  originsOf,
  rowCreateBlockedMessage,
} from './origin';
import type { TrackerField } from './schema';

type HasOrigins = { origins?: unknown };

/**
 * El único punto de rechazo de escrituras contra tablas que vienen de una
 * integración (0237). Separado de `origin.ts` (puro, sin dependencias) para que
 * la interfaz importe aquello sin arrastrar `@cortex/core`.
 */

/**
 * ¿Se puede escribir esto? Lanza `ValidationError` en español si toca campos del
 * origen (cambiados de verdad) o si agrega una fila a mano a una tabla que se
 * llena sola. Quien llama pasa lo que había (`before`, null si es una fila
 * nueva) y lo que quedaría (`after`): sólo cuenta lo que CAMBIA, así una grilla
 * que manda la fila completa no tropieza con los campos que no tocó.
 */
export function assertRowWriteAllowed(
  tracker: (HasOrigins & { fields: TrackerField[] }) | null | undefined,
  input: {
    creating?: boolean;
    before?: Record<string, unknown> | null;
    after: Record<string, unknown>;
    /** Sólo estos campos se están escribiendo (parche); por omisión, todos los de `after`. */
    keys?: Iterable<string>;
    /**
     * La `external_key` de la fila que se cambia: con valor es una fila que
     * trajo el origen; `null` es una fila hecha a mano. Sin decirla (`undefined`)
     * se supone que viene del origen. En hojas y carpetas el candado es sólo de
     * las filas del origen; en un programa contable es de todas.
     */
    externalKey?: string | null;
  },
): void {
  const origins = originsOf(tracker);
  if (!origins.length || !tracker) return;
  if (input.creating) {
    const maker = creatingOrigin(tracker);
    if (maker) throw new ValidationError(rowCreateBlockedMessage(maker));
  }
  const fromOrigin = input.creating ? false : input.externalKey === undefined || Boolean(input.externalKey);
  const keys = input.keys ? [...input.keys] : Object.keys(input.after);
  const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');
  const touched = new Map<TrackerOrigin, string[]>();
  for (const k of keys) {
    const o = originOfField(tracker, k);
    if (!o) continue;
    // Una fila hecha a mano en una hoja o carpeta no tiene candado.
    if (o.kind !== 'accounting' && !fromOrigin) continue;
    // Una fila nueva: escribir un campo del origen (con valor) es escribirlo.
    if (input.before ? same(input.before[k], input.after[k]) : same(undefined, input.after[k]))
      continue;
    const label = tracker.fields.find((f) => f.key === k)?.label ?? k;
    touched.set(o, [...(touched.get(o) ?? []), label]);
  }
  const first = [...touched.entries()][0];
  if (first) throw new ValidationError(fieldLockedMessage(first[0], first[1]));
}

/**
 * trackers.define sobre una tabla sincronizada: sólo se agregan o cambian campos
 * propios. Los del origen no se quitan ni se cambian (tipo, opciones, fórmula…;
 * la etiqueta sí se puede renombrar). Lanza si lo intentan.
 */
export function assertDefineAllowed(
  existing: (HasOrigins & { fields: TrackerField[] }) | null | undefined,
  nextFields: TrackerField[],
): void {
  const origins = originsOf(existing);
  if (!origins.length || !existing) return;
  for (const f of existing.fields) {
    // Sólo los programas contables fijan la forma de sus campos; una hoja o carpeta
    // se redefine como cualquier tabla (la sincronización se adapta).
    const o = hardOriginOfField(existing, f.key);
    if (!o) continue;
    const next = nextFields.find((n) => n.key === f.key);
    if (!next)
      throw new ValidationError(
        `«${f.label}» viene de ${originName(o)} y no se puede quitar. Puedes agregar campos propios encima de esta tabla.`,
      );
    const strip = (x: TrackerField) => {
      const { label: _label, ...rest } = x as TrackerField & { label?: string };
      return JSON.stringify(rest, Object.keys(rest).sort());
    };
    if (strip(f) !== strip(next))
      throw new ValidationError(
        `«${f.label}» viene de ${originName(o)}: su tipo y sus opciones los define la conexión, no se cambian aquí. Puedes cambiar sus etiquetas o agregar campos propios.`,
      );
  }
}
