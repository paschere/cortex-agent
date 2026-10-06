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
  applyDuplicateRule,
  computeDuplicateFlags,
  duplicateMessage,
  duplicateRuleSchema,
  getDuplicateRule,
  normalizeDuplicateKey,
  validateDuplicateRule,
} from './duplicates';
export type { DuplicateRule } from './duplicates';

export {
  FIELD_FORMATS,
  FORMAT_LABEL,
  checkFormat,
  compilePattern,
  isSafePattern,
  isValidAwb,
  isValidNit,
  normalizeFormatted,
} from './formats';
export type { FieldFormat } from './formats';

export {
  defaultValues,
  isFieldVisible,
  nowBogota,
  resolveBound,
  todayBogota,
  uniqueKey,
  validateRowValues,
  violationsByKey,
  visibleKeys,
  withDefaults,
} from './validation';
export type { ValidateOptions, Violation } from './validation';

export {
  FILE_MAX_COUNT,
  FIELD_KEY_RE,
  FIELD_TYPES,
  displayTrackerValue,
  formatLocation,
  mapsUrl,
  parseFileValue,
  parseLocation,
  parseRelationValue,
  showIfSchema,
  TRACKER_SLUG_RE,
  coerceValue,
  parseCheckbox,
  fieldByKey,
  rowLabel,
  trackerFieldSchema,
  trackerFieldsSchema,
  trackerSlugSchema,
} from './schema';
export type {
  FieldType,
  FileValueRef,
  GeoPoint,
  RelationRef,
  ShowIf,
  TrackerField,
} from './schema';

export {
  TRACKER_COLUMNS,
  TRACKER_ROW_COLUMNS,
  defineTracker,
  getTrackerById,
  getTrackerBySlug,
  listTrackers,
  markForReview,
  prepareValues,
  queryRows,
  removeRow,
  removeTracker,
  shapeValues,
  shapeValuesDetailed,
  upsertRow,
} from './store';
export type { ShapeOptions, TrackerEntryRow, TrackerRow } from './store';
