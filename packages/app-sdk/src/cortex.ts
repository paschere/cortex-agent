import { call } from './bridge';
import type {
  QueryOptions,
  SdkField,
  SdkGeofence,
  SdkLocation,
  SdkRow,
  SdkTable,
  SdkUser,
} from './types';

/**
 * `cortex`: todas las operaciones como promesas. Se agrupan igual que en el
 * servidor (`tables.query` ↔ op `tables.query`). Las de `nav` y `ui` las
 * resuelve el propio host sin ir al servidor.
 */
export const cortex = {
  user: {
    /** Quién está usando la pantalla, con su rol y atributos. */
    me: () => call<SdkUser>('user.me'),
  },
  tables: {
    /** Las tablas que el rol puede leer, con sus campos. */
    list: () => call<SdkTable[]>('tables.list'),
    query: (table: string, opts: QueryOptions = {}) =>
      call<{ rows: SdkRow[]; fields?: SdkField[]; total?: number }>('tables.query', {
        table,
        ...opts,
      }),
    get: (table: string, id: string) => call<SdkRow>('tables.get', { table, id }),
    insert: (table: string, values: Record<string, unknown>) =>
      call<SdkRow>('tables.insert', { table, values }),
    update: (table: string, id: string, values: Record<string, unknown>) =>
      call<SdkRow>('tables.update', { table, id, values }),
  },
  locations: {
    /** Última ubicación de cada persona (solo si el rol puede verlas). */
    live: () => call<SdkLocation[]>('locations.live'),
  },
  geofences: {
    list: () => call<SdkGeofence[]>('geofences.list'),
  },
  ai: {
    /** Pregunta corta al modelo rápido, con datos opcionales. Devuelve texto. */
    ask: (prompt: string, data?: unknown) => call<string>('ai.ask', { prompt, data }),
  },
  functions: {
    /** Función de servidor de la app (fase 2). */
    call: <T = unknown>(name: string, input?: unknown) =>
      call<T>('functions.call', { name, input }),
  },
  db: {
    /** SQL sobre la base propia de la app (fase 3). */
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      call<{ rows: T[] }>('db.query', { sql, params }),
  },
  nav: {
    /** Abre otra pantalla de la app, con campos prellenados si se quiere. */
    go: (target: { screen: string; prefill?: Record<string, string | number> }) =>
      call<void>('nav.go', target),
  },
  ui: {
    /** Muestra un aviso breve arriba del marco de la app. */
    toast: (text: string) => call<void>('ui.toast', { text }),
  },
};
