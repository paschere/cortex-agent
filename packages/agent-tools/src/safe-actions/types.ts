import type { ToolContext } from '../types';

/**
 * ACCIONES SEGURAS DE REPETIR — los tipos (migración 0168).
 *
 * Una herramienta con efectos fuera de Cortex (un correo, un mensaje, un evento
 * en el calendario, un pago anotado, una fila nueva) puede llegar dos veces a
 * `runTool` por razones que nadie decidió: el modelo reintenta, la red
 * reintenta, Inngest o pg-boss repiten un paso, alguien pulsa dos veces
 * «Aprobar». La segunda llegada no es una segunda intención; es la primera otra
 * vez. Esta política es cómo una herramienta lo declara, y `runTool` es quien la
 * cumple: la herramienta no tiene que acordarse de nada.
 *
 * Se declara de dos formas, y gana la primera:
 *   · `safeAction` en el propio `registerTool({...})`;
 *   · una entrada en `safe-actions/catalog.ts`, para las herramientas cuyo
 *     archivo no conviene tocar o cuya verificación usa clientes compartidos.
 */

/** Lo que dijo la comprobación posterior. */
export type VerifyStatus = 'verified' | 'not_verified' | 'unverifiable';

export interface VerifyOutcome {
  status: VerifyStatus;
  /**
   * Una frase en español, para la persona y para el modelo: «el correo está en
   * Enviados», «Outlook todavía no lo muestra en Enviados».
   */
  detail: string;
}

export interface VerifyArgs<I, O> {
  input: I;
  output: O;
  ctx: ToolContext;
  /** Cuándo empezó la ejecución que se está verificando. */
  startedAt: Date;
}

export interface SafeActionPolicy<I = unknown, O = unknown> {
  /**
   * Durante cuánto tiempo la misma acción, ya hecha, se devuelve en vez de
   * repetirse. Por defecto 24 h. `0` desactiva la guardia de repetición y deja
   * sólo la verificación.
   */
  windowMs?: number;
  /**
   * Qué parte del input identifica la acción. Por defecto, el input entero
   * (canonizado). Devolver `null` deja ESTA llamada sin guardia: por ejemplo,
   * `trackers.upsert` con `rowId` es una actualización y ya es idempotente.
   */
  key?: (input: I) => unknown;
  /**
   * Comprobar que el efecto de verdad ocurrió (el correo está en Enviados, el
   * evento existe, la fila está). Nunca debe lanzar para decir «no»: devuelve
   * `not_verified`. Si lanza, el resultado se registra como `unverifiable`.
   */
  verify?: (args: VerifyArgs<I, O>) => Promise<VerifyOutcome>;
  /** Cómo nombrar lo hecho en los avisos: «el correo», «el evento». */
  noun?: string;
}

export type AnySafeActionPolicy = SafeActionPolicy<never, never>;

/** Estado de una fila de `action_idempotency`. */
export type ActionStatus = 'in_flight' | 'succeeded' | 'failed';

export interface ActionRow {
  key: string;
  tool_id: string;
  status: ActionStatus;
  attempt_id: string;
  attempts: number;
  claimed_at: string;
  finished_at: string | null;
  window_ends_at: string | null;
  result: unknown;
  result_summary: string | null;
  verification: VerifyStatus | null;
  verification_detail: string | null;
}
