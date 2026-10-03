import type { GridColumn, GridQueryResult, GridRow, GridView } from '@/components/datagrid/types';
import type { TrackerFieldLike } from '@/lib/datagrid/trackers';

/**
 * Lo que viaja entre las páginas de tablas (servidor) y sus pantallas
 * (cliente), y la forma de las acciones — reales en /trackers, de mentira en
 * /v/datagrid-showcase.
 */

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface SyncBadge {
  id: string;
  kind: 'table_sync' | 'drive_folder';
  source: string;
  every: string;
  state: 'ok' | 'error' | 'paused' | 'waiting';
  lastRunAt: string | null;
  lastError: string | null;
  lastInserted: number;
  lastUpdated: number;
}

export interface TrackerCardData {
  id: string;
  slug: string;
  name: string;
  description: string;
  rowCount: number;
  fieldCount: number;
  fields: TrackerFieldLike[];
  updatedAt: string;
  createdBy: string | null;
  syncs: SyncBadge[];
  /** Tipo de trabajo si la tabla «se mide como trabajo» (Equipo › Qué se mide). */
  workType: string | null;
}

export interface TrackerScreenData {
  tracker: {
    id: string;
    slug: string;
    name: string;
    description: string;
    fields: TrackerFieldLike[];
    createdBy: string | null;
    updatedAt: string;
  };
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  savedViews: GridView[];
  syncs: SyncBadge[];
  workType: string | null;
  /** Hay filas que trae una sincronización (las puede sobrescribir la próxima corrida). */
  syncedRows: number;
  canChangeSchema: boolean;
}

export interface HistoryEntry {
  at: string;
  who: string;
  what: string;
}

export interface NewTrackerInput {
  name: string;
  description: string;
  fields: Array<{
    label: string;
    type: TrackerFieldLike['type'];
    required?: boolean;
    options?: string[];
  }>;
}

export interface TrackerActions {
  edit: (
    trackerId: string,
    rowId: string,
    key: string,
    value: unknown,
  ) => Promise<ActionResult<{ row: GridRow }>>;
  bulkEdit: (
    trackerId: string,
    rowIds: string[],
    key: string,
    value: unknown,
  ) => Promise<ActionResult<{ changed: number }>>;
  create: (
    trackerId: string,
    values: Record<string, unknown>,
  ) => Promise<ActionResult<{ row: GridRow }>>;
  remove: (trackerId: string, rowIds: string[]) => Promise<ActionResult<{ removed: number }>>;
  addColumn: (
    trackerId: string,
    column: { label: string; type: string; options?: string[]; required?: boolean },
  ) => Promise<ActionResult<{ column: GridColumn }>>;
  query: (
    trackerId: string,
    view: GridView,
    page: { offset: number; limit: number },
  ) => Promise<ActionResult<GridQueryResult>>;
  history: (trackerId: string, rowId: string) => Promise<ActionResult<{ entries: HistoryEntry[] }>>;
  syncNow: (kind: SyncBadge['kind'], syncId: string) => Promise<ActionResult<{ message: string }>>;
  listViews: (scope: string) => Promise<GridView[]>;
  saveView: (scope: string, view: GridView) => Promise<GridView>;
  deleteView: (id: string) => Promise<void>;
}

export interface TrackersIndexActions {
  /** `keys`: la clave que quedó para cada columna, en el orden en que se mandaron. */
  createTracker: (
    input: NewTrackerInput,
  ) => Promise<ActionResult<{ slug: string; id: string; keys: string[] }>>;
  importRows: (
    trackerId: string,
    rows: Array<Record<string, string | number>>,
  ) => Promise<ActionResult<{ inserted: number; errors: Array<{ row: number; message: string }> }>>;
  readSpreadsheet: (form: FormData) => Promise<ActionResult<{ rows: string[][]; sheet: string }>>;
}
