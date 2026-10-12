import { AsyncLocalStorage } from 'node:async_hooks';
import { ValidationError } from '@cortex/core';
import { type FlowActor, type FlowFieldLike, checkTransition, flowOf } from './flow';

/**
 * LA REGLA DEL FLUJO, HECHA CUMPLIR EN EL SERVIDOR.
 *
 * Todo camino que escribe una fila de una tabla con flujo (chat, tabla del
 * equipo, formulario, celda, tarjeta, botón de una app) pasa por
 * `guardFlowWrite`: un salto que el flujo no permite, que el rol no puede hacer
 * o al que le faltan requisitos se rechaza AUNQUE el navegador lo mande.
 *
 * Quién es el actor lo pone la capa de apps con `withFlowActor` (rol de la
 * app); fuera de una app (chat, equipo) no hay roles y sólo se exige que el
 * salto exista y sus requisitos se cumplan. Un enlace público sin sesión es
 * el actor más estricto: sólo saltos que no piden rol.
 */

const store = new AsyncLocalStorage<FlowActor>();

export function withFlowActor<T>(actor: FlowActor, fn: () => Promise<T>): Promise<T> {
  return store.run(actor, fn);
}

export const UNSCOPED_ACTOR: FlowActor = { roles: [], admin: false, unscoped: true };
export const ANONYMOUS_ACTOR: FlowActor = { roles: [], admin: false };

export function currentFlowActor(fallback: FlowActor = UNSCOPED_ACTOR): FlowActor {
  return store.getStore() ?? fallback;
}

type Values = Record<string, string | number>;

/**
 * Valida (y, en una fila nueva, completa) el cambio de estado. Devuelve los
 * valores a guardar: iguales, salvo que una fila nueva sin estado nace en el
 * primero. Lanza `ValidationError` con la razón en español.
 */
export function guardFlowWrite(
  tracker: { fields: readonly FlowFieldLike[] },
  before: Record<string, unknown> | null,
  after: Values,
  actor: FlowActor = currentFlowActor(),
): Values {
  const f = flowOf(tracker.fields);
  if (!f) return after;
  const key = f.field.key;
  const created = before === null;
  let values = after;
  const filled = values[key] !== undefined && String(values[key]).trim() !== '';
  if (created && !filled) values = { ...values, [key]: f.flow.states[0] as string };
  const prior = created ? undefined : before?.[key];
  const previous = prior === undefined || prior === null ? null : String(prior);
  const check = checkTransition({
    flow: f.flow,
    field: f.field,
    fields: tracker.fields,
    from: previous,
    to: values[key] === undefined ? null : String(values[key]),
    values: { ...(before ?? {}), ...values },
    actor,
  });
  if (!check.ok)
    throw new ValidationError(check.message ?? 'Ese cambio de estado no está permitido.');
  return values;
}
