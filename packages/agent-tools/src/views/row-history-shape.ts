import type { TrackerField } from '../trackers/schema';

/**
 * HISTORIAL DE UNA FILA: LAS REGLAS PURAS (de dónde vino cada cambio y cómo se deshace).
 *
 * La historia de un registro junta tres rastros que ya existían:
 *   - `custom_view_events`: lo que se editó o movió desde una pantalla de una
 *     app (o desde un enlace público), con el antes → después por campo;
 *   - `audit_events` de `trackers.upsert`: lo que Cortex cambió desde el chat o
 *     desde una rutina (trae los valores de antes en `metadata.detail.before`);
 *   - las corridas de automatizaciones (ya en `record-history.ts`).
 * Cada cambio lleva su ORIGEN en claro: app, chat, automatización, enlace
 * público o «al deshacer». «Deshacer este cambio» vuelve cada campo a su valor
 * de antes SÓLO si hoy sigue valiendo lo que el cambio dejó: si alguien lo
 * tocó después, ese campo no se pisa (se dice cuál).
 *
 * Los cambios hechos por una sincronización (hoja, carpeta de Drive,
 * contabilidad) escriben la fila directamente y no dejan rastro por campo: no
 * aparecen aquí.
 */

export type ChangeOrigin = 'app' | 'chat' | 'automation' | 'link' | 'undo' | 'rule';

export const ORIGIN_LABEL: Record<ChangeOrigin, string> = {
  app: 'Desde la app',
  chat: 'Desde el chat',
  automation: 'Desde una rutina',
  link: 'Desde el enlace público',
  undo: 'Al deshacer un cambio',
  rule: 'Regla automática',
};

/** «Regla: Total del vuelo»; sin nombre (quien mira no es del equipo) queda genérico. */
export function ruleOriginLabel(name?: string | null): string {
  return name?.trim() ? `Regla: ${name.trim()}` : ORIGIN_LABEL.rule;
}

/** El `action_id` con que se registra un cambio hecho al deshacer otro. */
export const UNDO_ACTION_ID = '__undo';

export type FieldChanges = Record<string, { from?: unknown; to?: unknown }>;

/** Una fila de `audit_events`, con sólo lo que se necesita. */
export interface AuditRowLike {
  id: string;
  tool_id: string;
  status: string;
  decision?: string | null;
  surface?: string | null;
  mandate_id?: string | null;
  metadata: Record<string, unknown> | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Cómo se hizo un cambio del chat: pedido directo o una rutina/delegación. */
export function auditOrigin(
  e: Pick<AuditRowLike, 'decision' | 'surface' | 'mandate_id'>,
): ChangeOrigin {
  return e.decision === 'delegated' || e.mandate_id || e.surface === 'schedule'
    ? 'automation'
    : 'chat';
}

/**
 * Los cambios que un `trackers.upsert` EDITÓ en `rowId`: campo por campo, con el
 * valor de antes si la auditoría lo guardó (`from: undefined` = no se sabe, y no
 * se puede deshacer). null si no fue una edición de esa fila.
 */
export function auditEventChanges(event: AuditRowLike, rowId: string): FieldChanges | null {
  if (event.tool_id !== 'trackers.upsert' || event.status !== 'ok') return null;
  const detail = obj(event.metadata?.detail);
  const input = obj(detail?.input);
  const result = obj(detail?.result);
  const row = obj(result?.row);
  if (!input || !result || result.created !== false || row?.id !== rowId) return null;
  const values = obj(input.values);
  if (!values) return null;
  const before = obj(detail?.before);
  const out: FieldChanges = {};
  for (const [k, to] of Object.entries(values)) {
    const had = before && k in before;
    const from = had ? before[k] : undefined;
    if (had && String(from ?? '') === String(to ?? '')) continue;
    out[k] = { from, to };
  }
  return Object.keys(out).length ? out : null;
}

/** Un campo que se puede devolver a mano: no se calcula solo y no es un archivo. */
export function isRevertable(field: TrackerField | undefined): boolean {
  if (!field) return false;
  if (field.formula || (field.lookup && !field.lookup.editable)) return false;
  return field.type !== 'file';
}

/** ¿Hay algo en este evento que se pueda deshacer? (para mostrar el botón) */
export function undoableKeys(
  changes: FieldChanges,
  fields: readonly TrackerField[],
  visible: ReadonlySet<string>,
): string[] {
  return Object.entries(changes)
    .filter(
      ([k, c]) =>
        visible.has(k) &&
        c.from !== undefined &&
        isRevertable(fields.find((f) => f.key === k)),
    )
    .map(([k]) => k);
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();

export interface UndoPlan {
  /** Campo → valor de antes (texto vacío = dejarlo en blanco). */
  patch: Record<string, string | number>;
  /** Campos que cambiaron otra vez después de este cambio: no se pisan. */
  conflicts: string[];
  /** Campos que ya valen lo de antes (nada que hacer). */
  already: string[];
}

/**
 * Qué escribir para deshacer un cambio: cada campo vuelve a su `from` si hoy
 * vale lo que el cambio dejó (`to`). `allowed` limita a lo que el rol puede
 * escribir (null = todo).
 */
export function planUndo(
  changes: FieldChanges,
  current: Readonly<Record<string, unknown>>,
  fields: readonly TrackerField[],
  allowed: ReadonlySet<string> | null,
): UndoPlan {
  const plan: UndoPlan = { patch: {}, conflicts: [], already: [] };
  for (const [k, c] of Object.entries(changes)) {
    if (c.from === undefined || !isRevertable(fields.find((f) => f.key === k))) continue;
    if (allowed && !allowed.has(k)) continue;
    if (same(current[k], c.from)) plan.already.push(k);
    else if (same(current[k], c.to)) {
      const from = c.from;
      plan.patch[k] =
        from === null || from === '' ? '' : typeof from === 'number' ? from : String(from);
    } else plan.conflicts.push(k);
  }
  return plan;
}
