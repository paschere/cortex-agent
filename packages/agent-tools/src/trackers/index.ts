/**
 * Tablas que esta empresa se inventa (migración 0115).
 *
 * Dos tablas Postgres, campos en JSON. El agente las define, las llena y las
 * consulta. No sustituyen clientes, vencimientos, cartera ni vehículos.
 */

import './tools';
import './flow-tools';

export { trackersSetFlow } from './flow-tools';
export {
  trackersDefine,
  trackersList,
  trackersQuery,
  trackersRemove,
  trackersUpsert,
  trackersUpsertMany,
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
  FORMULA_RESULT_TYPES,
  adaptLookupValue,
  applyComputed,
  changedComputedKeys,
  computedProblems,
  fillLookups,
  fillableFields,
  formulaDependencies,
  formulaOrder,
  fromFVal,
  lookupSources,
  relationParts,
  resolveFieldRef,
  toFVal,
} from './computed';
export type { ComputedFieldLike } from './computed';
export {
  FORMULA_FUNCTIONS,
  FORMULA_MAX,
  evaluateFormula,
  evaluateParsed,
  parseFormula,
} from './formula';
export type { FVal, FormulaResult } from './formula';
export {
  autofillConfigs,
  autofillReady,
  mergeSuggestions,
  sanitizeSuggestion,
  triggerSignature,
} from './autofill-shape';
export type { AutofillConfig, MergeResult as SuggestionMerge, Suggestion } from './autofill-shape';

export {
  FLOW_REQUIREMENT_KINDS,
  FLOW_REQUIREMENT_LABEL,
  buildFlowView,
  checkTransition,
  describeFlow,
  flowAutomationDrafts,
  flowOf,
  flowProblems,
  flowSchema,
  isFilled,
  linearTransitions,
  normalizeFlow,
  missingRequirements,
  transitionAllowed,
  transitionHistory,
} from './flow';
export {
  ANONYMOUS_ACTOR,
  UNSCOPED_ACTOR,
  currentFlowActor,
  guardFlowWrite,
  withFlowActor,
} from './flow-guard';
export type {
  ComputedFlow,
  Flow as StateFlow,
  FlowActor,
  FlowCheck,
  FlowHistoryEntry,
  FlowNextMove,
  FlowRequirement,
  FlowStep,
  FlowTransition,
} from './flow';

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
  recomputeRows,
  removeRow,
  removeRows,
  removeTracker,
  shapeValues,
  shapeValuesDetailed,
  upsertRow,
} from './store';
export type { ShapeOptions, TrackerEntryRow, TrackerRow } from './store';
