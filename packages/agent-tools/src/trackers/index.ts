/**
 * Tablas que esta empresa se inventa (migración 0115).
 *
 * Dos tablas Postgres, campos en JSON. El agente las define, las llena y las
 * consulta. No sustituyen clientes, vencimientos, cartera ni vehículos.
 */

import './tools';

export {
  trackersDefine,
  trackersList,
  trackersQuery,
  trackersRemove,
  trackersUpsert,
} from './tools';

export {
  FIELD_KEY_RE,
  FIELD_TYPES,
  TRACKER_SLUG_RE,
  coerceValue,
  fieldByKey,
  rowLabel,
  trackerFieldSchema,
  trackerFieldsSchema,
  trackerSlugSchema,
} from './schema';
export type { FieldType, TrackerField } from './schema';

export {
  TRACKER_COLUMNS,
  TRACKER_ROW_COLUMNS,
  defineTracker,
  getTrackerById,
  getTrackerBySlug,
  listTrackers,
  queryRows,
  removeRow,
  removeTracker,
  shapeValues,
  upsertRow,
} from './store';
export type { TrackerEntryRow, TrackerRow } from './store';
