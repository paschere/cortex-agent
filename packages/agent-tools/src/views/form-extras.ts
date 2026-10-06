/**
 * LO PURO DE LOS FORMULARIOS DE VISTA «CON EXTRAS» (migración 0204): la
 * ventana para corregir lo enviado, qué estado lleva Aprobar / Rechazar y la
 * validación por pasos. Sin base ni red: lo usan el servidor, la pantalla y
 * las pruebas.
 */

import type { FormApproval, FormStep } from './spec';

// ---------------------------------------------------------------------------
// Corregir lo enviado
// ---------------------------------------------------------------------------

/** ¿Sigue abierta la ventana para corregir un envío hecho en `createdAt`? */
export function editWindowOpen(
  createdAt: string | Date,
  minutes: number,
  now: Date = new Date(),
): boolean {
  if (!(minutes > 0)) return false;
  const at = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < minutes * 60_000;
}

/** Hasta cuándo se puede corregir (ISO), o null si el formulario no lo permite. */
export function editDeadline(createdAt: string | Date, minutes: number): string | null {
  if (!(minutes > 0)) return null;
  const at = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(at) ? new Date(at + minutes * 60_000).toISOString() : null;
}

/** Comparación de tokens que no delata en cuál carácter falló. */
export function sameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type EditDecision = { ok: true } | { ok: false; reason: 'window' | 'who' };

/**
 * ¿Puede esta persona corregir este envío? Dentro de la ventana, y sólo quien
 * lo mandó: con sesión, el mismo usuario; sin sesión, quien trae el token de
 * edición que el envío devolvió.
 */
export function canEditSubmission(input: {
  submission: { created_at: string; submitted_by: string | null; edit_token: string | null };
  minutes: number;
  actor: string | null;
  token: string | null | undefined;
  now?: Date;
}): EditDecision {
  const s = input.submission;
  if (!editWindowOpen(s.created_at, input.minutes, input.now))
    return { ok: false, reason: 'window' };
  const byUser = Boolean(input.actor && s.submitted_by && input.actor === s.submitted_by);
  if (byUser || sameToken(s.edit_token, input.token)) return { ok: true };
  return { ok: false, reason: 'who' };
}

export const EDIT_MESSAGES = {
  window: 'Ya pasó el tiempo para corregir este envío.',
  who: 'Sólo quien lo envió puede corregirlo.',
  reviewed: 'Este envío ya fue revisado y no se puede corregir.',
  off: 'Este formulario no permite corregir lo enviado.',
} as const;

// ---------------------------------------------------------------------------
// Aprobación
// ---------------------------------------------------------------------------

/** El campo (y notas) que una decisión escribe; el valor lo pone el SPEC, no el navegador. */
export function reviewPatch(
  approval: FormApproval,
  decision: 'approve' | 'reject',
  reason?: string | null,
): Record<string, string> {
  const patch: Record<string, string> = {
    [approval.field]: decision === 'approve' ? approval.approved : approval.rejected,
  };
  const note = (reason ?? '').trim().slice(0, 300);
  if (decision === 'reject' && approval.notesField && note) patch[approval.notesField] = note;
  return patch;
}

/** ¿Está la fila esperando revisión? */
export function isPendingReview(
  approval: FormApproval,
  values: Record<string, unknown> | null | undefined,
): boolean {
  return String(values?.[approval.field] ?? '') === approval.pending;
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

/**
 * Los campos de cada paso, en el orden del paso, sin los que `visible` oculta
 * (showIf) ni los que el formulario ya no pide. Los campos que ningún paso
 * nombra van en un último paso «Otros datos», para que nada quede sin pedir.
 */
export function stepFields(
  steps: FormStep[],
  fieldKeys: string[],
): Array<{ title: string; fields: string[] }> {
  const known = new Set(fieldKeys);
  const used = new Set<string>();
  const out = steps
    .map((s) => ({
      title: s.title,
      fields: s.fields.filter((k) => known.has(k) && !used.has(k) && used.add(k)),
    }))
    .filter((s) => s.fields.length > 0);
  const rest = fieldKeys.filter((k) => !used.has(k));
  if (rest.length) out.push({ title: 'Otros datos', fields: rest });
  return out;
}

/**
 * Los errores de UN paso: sólo se juzgan los campos que el paso muestra
 * (visibles). `errors` es el mapa campo → mensaje de todo el formulario.
 */
export function stepErrors(
  step: { fields: string[] },
  visible: ReadonlySet<string>,
  errors: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of step.fields) if (visible.has(k) && errors[k]) out[k] = errors[k] as string;
  return out;
}

/** Pasos que se pueden mostrar: sin los que quedaron sin campos visibles. */
export function visibleSteps<T extends { fields: string[] }>(
  steps: T[],
  visible: ReadonlySet<string>,
): T[] {
  return steps.filter((s) => s.fields.some((k) => visible.has(k)));
}
