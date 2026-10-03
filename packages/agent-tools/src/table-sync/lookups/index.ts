/**
 * Consulta por fila (migración 0198): una URL de API por fila de una tabla,
 * con filtro, intervalo adaptativo y tope diario.
 */

import './tools';

export { trackersRowLookupCreate, trackersRowLookupStatus, trackersRowLookupUpdate } from './tools';
export {
  type LookupFetcher,
  type LookupHttpResult,
  type LookupNotice,
  type LookupPreview,
  type LookupRunOutcome,
  defaultLookupFetcher,
  describeCredentialProblem,
  previewLookup,
  runRowLookup,
} from './run';
export {
  type LookupInput,
  type LookupPatch,
  type LookupStatusInfo,
  createRowLookup,
  findRowLookup,
  listRowLookups,
  resolveCredential,
  rowLookupStatus,
  unknownTemplateFields,
  updateRowLookup,
  validateLookup,
} from './store';
export {
  type LookupPlan,
  type MappedValues,
  type PlanSpec,
  cadenceFor,
  lookupToday,
  mapResponse,
  nextAtAfter,
  nextResetMs,
  planLookup,
  valueAtPath,
} from './plan';
export { matchesLookupFilter, matchesOne, unknownFilterFields } from './filter';
export {
  describeTemplateProblem,
  hostOfTemplate,
  renderInputTokens,
  renderLookupUrl,
  templateFields,
} from './template';
export {
  DEFAULT_DAILY_CAP,
  DEFAULT_PER_RUN_CAP,
  GRID_FILTER_OPS,
  LOOKUP_COLUMNS,
  lookupFilterSchema,
  lookupMappingSchema,
  lookupNearSchema,
} from './types';
export type {
  LookupFilter,
  LookupFilterInput,
  LookupMappingEntry,
  LookupNear,
  LookupNearInput,
  LookupStateRow,
  LookupStatus,
  RowLookupRow,
} from './types';
