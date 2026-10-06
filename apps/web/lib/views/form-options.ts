import type { TrackerField } from '@cortex/agent-tools';

/**
 * LO PURO DEL INSPECTOR DE FORMULARIOS: el orden de los campos que pide, los
 * pasos y la aprobación. Sin pantalla, para probarlo sin navegador.
 *
 * Reglas del contrato que se respetan aquí (las revisa `checkFormExtras`):
 * un paso nombra sólo campos que el formulario pide, un campo está en un solo
 * paso y un paso no puede estar vacío. Un campo que ningún paso nombra no se
 * pierde: el formulario lo pide en un último paso «Otros datos».
 */

export interface FormStepDraft {
  title: string;
  fields: string[];
}

/** Los campos que el formulario pide hoy, en orden; vacío = todos los de la tabla. */
export function askedKeys(blockFields: string[], tableFields: Array<{ key: string }>): string[] {
  return blockFields.length ? blockFields : tableFields.map((f) => f.key);
}

export function moveKey(keys: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= keys.length || to >= keys.length) return keys;
  const next = [...keys];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** Los pasos que quedan al cambiar qué pide el formulario: sin campos que ya no se piden ni pasos vacíos. */
export function pruneSteps(steps: FormStepDraft[], asked: string[]): FormStepDraft[] {
  const known = new Set(asked);
  return steps
    .map((s) => ({ ...s, fields: s.fields.filter((k) => known.has(k)) }))
    .filter((s) => s.fields.length > 0);
}

/** Campos pedidos que ningún paso nombra (van a «Otros datos»). */
export function unassigned(steps: FormStepDraft[], asked: string[]): string[] {
  const used = new Set(steps.flatMap((s) => s.fields));
  return asked.filter((k) => !used.has(k));
}

/** Empezar por pasos: todo lo que se pide en un primer paso, para ir partiéndolo. */
export function startSteps(asked: string[]): FormStepDraft[] {
  return asked.length ? [{ title: 'Paso 1', fields: [...asked] }] : [];
}

/** Un paso nuevo con un campo (no puede nacer vacío); el campo sale de donde estaba. */
export function addStep(steps: FormStepDraft[], key: string, max = 10): FormStepDraft[] {
  if (steps.length >= max) return steps;
  const without = steps.map((s) => ({ ...s, fields: s.fields.filter((k) => k !== key) }));
  return [
    ...without.filter((s) => s.fields.length),
    { title: `Paso ${steps.length + 1}`, fields: [key] },
  ];
}

/** Quita un paso: sus campos quedan sin paso (van a «Otros datos»). */
export function removeStep(steps: FormStepDraft[], index: number): FormStepDraft[] {
  return steps.filter((_, i) => i !== index);
}

/** Pone un campo en el paso `to` (o lo suelta con null), quitándolo de donde estaba. */
export function assignField(
  steps: FormStepDraft[],
  key: string,
  to: number | null,
): FormStepDraft[] {
  const moved = steps.map((s, i) => {
    const rest = s.fields.filter((k) => k !== key);
    return { ...s, fields: i === to ? [...rest, key] : rest };
  });
  return moved.filter((s) => s.fields.length > 0);
}

export function moveStep(steps: FormStepDraft[], from: number, to: number): FormStepDraft[] {
  if (from === to || to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

// ---------------------------------------------------------------------------
// Aprobación
// ---------------------------------------------------------------------------

export const APPROVAL_STATES = {
  pending: 'Por revisar',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

/** Campos de la tabla que sirven de estado: opciones, con al menos tres. */
export function approvalFieldCandidates(fields: TrackerField[]): TrackerField[] {
  return fields.filter((f) => f.type === 'select' && (f.options?.length ?? 0) >= 3);
}

/** Campos de texto para guardar el motivo. */
export function notesCandidates(fields: TrackerField[]): TrackerField[] {
  return fields.filter((f) => f.type === 'text' || f.type === 'longtext');
}

/**
 * Los tres estados por defecto para un campo: los que ya existan con nombres
 * conocidos, o si no las tres primeras opciones. null si no hay tres.
 */
export function guessApproval(field: TrackerField): {
  pending: string;
  approved: string;
  rejected: string;
} | null {
  const options = field.options ?? [];
  if (options.length < 3) return null;
  const find = (re: RegExp, fallback: string) => options.find((o) => re.test(o)) ?? fallback;
  const pending = find(/revisar|pendiente|nuevo|recibid/i, options[0] as string);
  const approved = find(
    /aprobad|aceptad|ok|conforme/i,
    options.find((o) => o !== pending) as string,
  );
  const rejected = find(
    /rechazad|negad|no conforme|devuelt/i,
    options.find((o) => o !== pending && o !== approved) as string,
  );
  if (new Set([pending, approved, rejected]).size < 3) {
    const [a, b, c] = options;
    return { pending: a as string, approved: b as string, rejected: c as string };
  }
  return { pending, approved, rejected };
}

/** El campo «Estado» que se ofrece crear si la tabla no tiene uno que sirva. */
export function approvalStateField(existingKeys: string[]): TrackerField {
  let key = 'estado';
  for (let i = 2; existingKeys.includes(key); i++) key = `estado_${i}`;
  return {
    key,
    label: existingKeys.includes('estado') ? 'Estado de revisión' : 'Estado',
    type: 'select',
    required: false,
    options: [APPROVAL_STATES.pending, APPROVAL_STATES.approved, APPROVAL_STATES.rejected],
  };
}
