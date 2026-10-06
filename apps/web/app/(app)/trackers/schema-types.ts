import type { DuplicateDraft } from '@/lib/trackers/schema-editor';
import type { ViewImpact } from '@/lib/trackers/schema-impact';
import type { TrackerField } from '@cortex/agent-tools/src/trackers/schema';

/**
 * Lo que viaja entre el editor de campos y reglas (cliente) y sus acciones
 * (servidor). Sin código de servidor: lo importan los dos lados.
 */

export interface SchemaSyncInfo {
  id: string;
  kind: 'table_sync' | 'drive_folder';
  /** «Fuente “Ventas”», «Carpeta de Drive “Guías”». */
  source: string;
  enabled: boolean;
  intervalMinutes: number;
  notify: boolean;
  keyFields: string[];
  /** Sólo Drive. */
  instructions: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface SchemaEditorData {
  tracker: {
    id: string;
    slug: string;
    name: string;
    description: string;
    fields: TrackerField[];
    duplicates: DuplicateDraft | null;
  };
  rowCount: number;
  syncs: SchemaSyncInfo[];
  /** Las demás tablas, para elegir a cuál apunta una relación. */
  otherTrackers: Array<{ slug: string; name: string }>;
  /** Su equipo le permite cambiar campos y reglas. */
  canEdit: boolean;
  /** Su equipo le permite correr y ajustar sincronizaciones. */
  canSync: boolean;
}

/** Qué pasaría si se guardara el borrador, calculado en el servidor. */
export interface SchemaImpact {
  /** Campos que se quitan, con cuántas filas tienen algo escrito en ellos. */
  removed: Array<{ key: string; label: string; rows: number }>;
  /** Opciones de un select que desaparecen. */
  droppedOptions: Array<{ key: string; label: string; options: string[] }>;
  /** Vistas que quedarían con problemas: el cambio NO se guarda mientras haya alguna. */
  views: ViewImpact[];
  /** Reglas, sincronizaciones o mediciones que dependen de lo que se quita. */
  blockers: string[];
  /** Hay datos que se pierden de vista y hace falta la confirmación explícita. */
  needsConfirm: boolean;
  canSave: boolean;
}

export type SchemaResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; needsConfirm?: boolean };

export interface SchemaSaveInput {
  name: string;
  description: string;
  fields: TrackerField[];
  duplicates: DuplicateDraft | null;
  /** Las claves de campos con datos cuya eliminación la persona ya confirmó. */
  confirmRemoved: string[];
}

/** Una hoja conectada del Feed de la persona, con sus pestañas, para crear una tabla desde ella. */
export interface SheetSourceInfo {
  id: string;
  name: string;
  tabs: Array<{ index: number; name: string; rows: number }>;
}

/** Lo que Cortex leyó de la hoja y propone, listo para abrir el editor prellenado. */
export interface SheetProposalView {
  sourceId: string;
  sheetIndex: number;
  suggestedName: string;
  fields: TrackerField[];
  /** Por cada campo: columna de la hoja de la que sale, por qué se propuso así y ejemplos. */
  evidence: Record<string, { sourceColumn: string; why: string[]; samples: string[] }>;
  keyColumns: string[];
  keyWhy: string;
  duplicates: (DuplicateDraft & { why: string }) | null;
  rows: number;
  notes: string[];
}

export interface SchemaActions {
  load: (slug: string) => Promise<SchemaResult<{ data: SchemaEditorData }>>;
  analyze: (
    trackerId: string,
    draft: Pick<SchemaSaveInput, 'fields' | 'duplicates'>,
  ) => Promise<SchemaResult<{ impact: SchemaImpact }>>;
  save: (
    trackerId: string,
    input: SchemaSaveInput,
  ) => Promise<SchemaResult<{ fields: TrackerField[] }>>;
  create: (input: {
    name: string;
    description: string;
    fields: TrackerField[];
    duplicates: DuplicateDraft | null;
  }) => Promise<SchemaResult<{ slug: string; id: string; fields: TrackerField[] }>>;
  listTrackers?: () => Promise<Array<{ slug: string; name: string }>>;
  listSheets?: () => Promise<SchemaResult<{ sources: SheetSourceInfo[] }>>;
  proposeFromSheet?: (
    sourceId: string,
    sheetIndex: number,
  ) => Promise<SchemaResult<{ proposal: SheetProposalView }>>;
  createFromSheet?: (input: {
    sourceId: string;
    sheetIndex: number;
    name: string;
    description: string;
    fields: TrackerField[];
    /** Campo → columna de la hoja. */
    columns: Record<string, string>;
    keyColumns: string[];
    duplicates: DuplicateDraft | null;
    intervalMinutes: number;
    notify: boolean;
  }) => Promise<SchemaResult<{ slug: string; id: string; fields: TrackerField[]; loaded: number }>>;
  updateSync: (
    kind: SchemaSyncInfo['kind'],
    syncId: string,
    patch: {
      enabled?: boolean;
      intervalMinutes?: number;
      notify?: boolean;
      keyFields?: string[];
      instructions?: string;
    },
  ) => Promise<SchemaResult<{ sync: SchemaSyncInfo }>>;
  syncNow: (
    kind: SchemaSyncInfo['kind'],
    syncId: string,
  ) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}
