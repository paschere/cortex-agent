/**
 * QUIÉN VE Y QUIÉN TOCA CADA TAREA — el mismo alcance que /actividad
 * (lib/activity/scope.ts): quien administra la empresa ve todo; cualquier otra
 * persona, sólo las suyas. La consulta ya viene acotada; esto es la regla
 * dicha en un sitio para que la pantalla, las rutas y las pruebas la compartan.
 */

export interface TaskViewer {
  id: string;
  /** Admin de la organización o dueño de la empresa. */
  isManager: boolean;
}

export interface OwnedTask {
  userId: string;
}

export function canSeeTask(viewer: TaskViewer, task: OwnedTask): boolean {
  return viewer.isManager || task.userId === viewer.id;
}

/** Cancelar: la dueña o quien administra. */
export function canCancelTask(viewer: TaskViewer, task: OwnedTask): boolean {
  return canSeeTask(viewer, task);
}

/** Reintentar crea una tarea NUEVA con los permisos de quien la crea: sólo la dueña. */
export function canRetryTask(viewer: TaskViewer, task: OwnedTask): boolean {
  return viewer.id === task.userId;
}

interface Chain<Q> {
  eq(column: string, value: unknown): Q;
}

export function applyTaskScope<Q extends Chain<Q>>(query: Q, viewer: TaskViewer): Q {
  return viewer.isManager ? query : query.eq('user_id', viewer.id);
}
