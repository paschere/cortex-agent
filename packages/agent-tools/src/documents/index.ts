/**
 * Document extraction: the paperwork this company already stores, read into
 * fields it can add up, without losing the words any of it came from.
 *
 * Deliberately narrow barrel. Everything here is either a tool (registered by
 * being imported) or something `apps/web` genuinely needs; the internals —
 * `verify.ts`, the prompts, the row shapes — are imported from their own files
 * by the tests that exercise them, the way `commitments/` does it. A wide
 * barrel in this package is not free: every name lands in `@cortex/agent-tools`
 * alongside a dozen other modules', and two of them colliding is a build error
 * in a file nobody touched.
 */

// Side-effect registration of the tools.
export { documentsExtract } from './extract-tool';
export {
  documentsPendingReview,
  documentsConfirm,
  documentsReject,
  documentsCorrectionStats,
} from './review-tools';
export { documentsRecords, documentsTotals } from './query-tools';

// The catalogue of what Cortex knows how to read. The web screen renders these
// labels and the review actions validate against them, and neither should keep
// a second copy of the list.
export {
  DOCUMENT_TYPES,
  documentType,
  documentTypeIds,
  fieldLabel,
  fieldSpec,
  money as documentMoney,
  typeLabel as documentTypeLabel,
} from './types';
export type { DocumentTypeSpec, FieldSpec, FieldKind, CanonicalSlot } from './types';

// Reads and writes, for the screen and its server actions.
export {
  adaptRecord,
  aggregateRecords,
  confirmExtraction,
  correctionStats,
  displayValue as displayFieldValue,
  findByDocument,
  getExtraction,
  hydrate as hydrateExtractions,
  listExtractions,
  listFields,
  queryRecords,
  readNit,
  rejectExtraction,
  resolveClientByNit,
  saveReading,
  standingValue as standingFieldValue,
} from './store';
export type {
  AggregateGroup,
  AggregateResult,
  ClientMatchState,
  CorrectionStat,
  ExtractionRecord,
  ExtractionRow,
  FieldDecision,
  FieldRow,
  RecordFilters,
  ReviewState as ExtractionReviewState,
} from './store';

// The reading itself, and the entry point the ingestion job calls.
export { EXTRACTOR_VERSION, readDocument } from './extract';
export type { ExtractionReading } from './extract';
export { extractDocumentData } from './ingest';
export type { ExtractionOutcome } from './ingest';
