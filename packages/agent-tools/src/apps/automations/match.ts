import type { AutomationTrigger, TriggerKind } from './spec';

/**
 * LO PURO DE «¿ESTE SUCESO DISPARA ESTA REGLA?». Sin base, sin reloj, sin
 * importar nada que toque la base: lo importa el punto donde se emiten los
 * eventos (que vive junto a las escrituras de filas) y no puede arrastrar
 * ciclos de módulos ni lecturas.
 */

export type Values = Record<string, string | number>;

export type AutomationActorKind = 'member' | 'app_user' | 'system' | 'automation';

export interface AutomationEvent {
  kind: TriggerKind;
  trackerId?: string;
  trackerSlug?: string;
  rowId?: string;
  /** La fila antes del cambio (sólo en ediciones y aprobaciones). */
  before?: Values | null;
  /** La fila después. */
  after?: Values;
  label?: string;
  /**
   * Identifica ESTA versión del suceso: la hora de la escritura, la franja de
   * un horario o el toque de un botón. Junto a la regla y la fila forma la
   * clave de idempotencia.
   */
  version: string;
  actor: { kind: AutomationActorKind; id?: string | null };
  /** Formulario: vista y bloque donde se llenó (para «pantalla/bloque»). */
  viewId?: string;
  blockId?: string;
  screen?: string;
  decision?: 'approved' | 'rejected';
  reason?: string;
  buttonId?: string;
  /** Reglas que llevaron hasta aquí (anti-bucles) y a cuántos saltos. */
  chain: string[];
  depth: number;
}

/** Profundidad máxima de reglas que disparan reglas. */
export const AUTOMATION_MAX_DEPTH = 3;

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined || a === null || b === null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function rowValue(
  values: Values | null | undefined,
  key: string,
): string | number | undefined {
  const v = values?.[key];
  return v === '' ? undefined : v;
}

/** ¿Cambió este campo entre antes y después? */
export function fieldChanged(event: AutomationEvent, field: string): boolean {
  return String(rowValue(event.before, field) ?? '') !== String(rowValue(event.after, field) ?? '');
}

/**
 * ¿El tipo, la tabla y los detalles del disparador coinciden con el suceso?
 * (Las condiciones «Si» se juzgan después, al ejecutar.) `screenOf` resuelve el
 * slug de la pantalla de un formulario cuando el disparador lo pide.
 */
export function matchesTrigger(
  trigger: AutomationTrigger,
  event: AutomationEvent,
  trackerSlug: string | null,
): boolean {
  if (trigger.type !== event.kind) return false;
  if ('tracker' in trigger && trackerSlug && trigger.tracker !== trackerSlug) return false;
  switch (trigger.type) {
    case 'row_created':
    case 'row_flagged_duplicate':
      return true;
    case 'row_updated': {
      if (trigger.field && !fieldChanged(event, trigger.field)) return false;
      if (trigger.to !== undefined) {
        if (!trigger.field) return false;
        return same(rowValue(event.after, trigger.field), trigger.to);
      }
      return true;
    }
    case 'form_submitted':
      return (
        (!trigger.screen || trigger.screen === event.screen) &&
        (!trigger.block || trigger.block === event.blockId)
      );
    case 'approval_decided':
      return (
        trigger.decision === 'any' ||
        (trigger.decision === 'approved' && event.decision === 'approved') ||
        (trigger.decision === 'rejected' && event.decision === 'rejected')
      );
    case 'schedule':
      return true;
    case 'button':
      return trigger.screen === event.screen && trigger.id === event.buttonId;
  }
}

/**
 * Sin bucles: una regla no se dispara a sí misma (ni por una vuelta larga:
 * A cambia algo que dispara B que cambia algo que dispara A) y la cadena no
 * pasa de `AUTOMATION_MAX_DEPTH` saltos.
 */
export function mayFire(
  automationId: string,
  event: Pick<AutomationEvent, 'chain' | 'depth'>,
): boolean {
  if (event.depth >= AUTOMATION_MAX_DEPTH) return false;
  return !event.chain.includes(automationId);
}

/** La clave única de una corrida: regla + fila + versión del suceso. */
export function automationIdempotencyKey(
  automationId: string,
  event: Pick<AutomationEvent, 'kind' | 'rowId' | 'version' | 'buttonId'>,
): string {
  return [automationId, event.kind, event.rowId ?? event.buttonId ?? '-', event.version].join(':');
}
