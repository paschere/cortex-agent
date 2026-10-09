/**
 * Una fila de `audit_events`, con sólo lo que /actividad necesita. Sin imports
 * de Node: lo usan funciones puras que también corren en las pruebas.
 */
export interface ActivityEvent {
  id: string;
  user_id: string;
  conversation_id: string | null;
  tool_id: string;
  status: string;
  decision: string | null;
  surface: string | null;
  mandate_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export type ActivityGroup =
  | 'email'
  | 'message'
  | 'rows'
  | 'calendar'
  | 'money'
  | 'document'
  | 'view'
  | 'other';

/** Cómo ocurrió: lo hizo solo, lo aprobaste, o lo pediste y se hizo. */
export type ActivityHow = 'auto' | 'approved' | 'direct';

export type ActivityFilter = 'all' | 'auto' | 'approved' | 'errors';
export const ACTIVITY_FILTERS: ActivityFilter[] = ['all', 'auto', 'approved', 'errors'];
export const ACTIVITY_FILTER_LABEL: Record<ActivityFilter, string> = {
  all: 'Todo',
  auto: 'Lo que hice solo',
  approved: 'Lo que aprobaste',
  errors: 'Errores',
};

/** Lo que hace falta para deshacer algo, ya resuelto. */
export interface UndoPlan {
  toolId: string;
  input: Record<string, unknown>;
  /** El texto del botón, p. ej. «Quitar la fila». */
  label: string;
}
