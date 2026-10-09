import type { ActivityEvent, ActivityFilter } from './types';

/**
 * QUIÉN VE QUÉ EN /actividad.
 *
 * Quien administra la empresa (admin de la organización o dueño) ve todo lo de
 * la empresa. Cualquier otra persona ve sólo lo que se hizo con SU sesión: sus
 * conversaciones y lo que ella pidió o aprobó. Un correo que mandó otra persona
 * o una rutina de otro no aparece aunque sea de la misma empresa.
 *
 * La restricción va en la consulta (`applyActivityScope`), no sólo en la
 * pantalla: lo que no se lee no se puede filtrar mal. `canSeeEvent` es la misma
 * regla como predicado, para las acciones de servidor que reciben un id.
 */
export interface Viewer {
  id: string;
  /** Admin de la organización o dueño de la empresa. */
  isManager: boolean;
}

export function canSeeEvent(viewer: Viewer, event: Pick<ActivityEvent, 'user_id'>): boolean {
  return viewer.isManager || event.user_id === viewer.id;
}

interface Chain<Q> {
  eq(column: string, value: unknown): Q;
  in(column: string, values: unknown[]): Q;
  or(filters: string): Q;
}

export function applyActivityScope<Q extends Chain<Q>>(query: Q, viewer: Viewer): Q {
  return viewer.isManager ? query : query.eq('user_id', viewer.id);
}

/** Los filtros de la pantalla, en la consulta. «Todo» = lo hecho y lo que falló. */
export function applyActivityFilter<Q extends Chain<Q>>(query: Q, filter: ActivityFilter): Q {
  switch (filter) {
    case 'auto':
      // Un mandato lo cubría, o lo hizo una rutina / el piloto sin nadie delante.
      return query.in('status', ['ok', 'error']).or('decision.eq.delegated,surface.eq.schedule');
    case 'approved':
      return query.in('status', ['ok', 'error']).eq('decision', 'confirmed');
    case 'errors':
      return query.eq('status', 'error');
    default:
      return query.in('status', ['ok', 'error']);
  }
}

const FILTERS: readonly string[] = ['all', 'auto', 'approved', 'errors'];
export function parseActivityFilter(value: string | undefined): ActivityFilter {
  return FILTERS.includes(value ?? '') ? (value as ActivityFilter) : 'all';
}
