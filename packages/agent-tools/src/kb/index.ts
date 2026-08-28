export { parseDocument } from './parsers';
export type { ParseResult } from './parsers';
export { chunkText, approxTokens } from './chunker';
export type { Chunk } from './chunker';
export { chunkTranscript, chunkOffsetMs, formatOffset } from './transcript-chunker';
export type { TranscriptChunk, TranscriptChunkMetadata } from './transcript-chunker';
export { transcribeAudio, mapDeepgramResponse, DEEPGRAM_LISTEN_URL } from './transcribe';
export type { SpeechTurn, Transcript, TranscribeResult, TranscribeFailure } from './transcribe';
export {
  embedDocuments,
  embedQuery,
  embedInBatches,
  embeddingConfig,
  embeddingModelId,
  planEmbeddingBatches,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDERS,
  PRICES_CHECKED_ON,
} from './embedder';
export type {
  EmbedFailure,
  EmbedResult,
  EmbedUsage,
  EmbeddingConfig,
  EmbeddingProviderId,
  EmbeddingModelFacts,
} from './embedder';
export {
  EMBEDDING_USAGE_TABLE,
  readEmbeddingSpend,
  recordEmbeddingUsage,
} from './embedding-usage';
export type {
  EmbeddingSpend,
  EmbeddingSpendDocument,
  EmbeddingUsageSource,
} from './embedding-usage';
export { kbSearch } from './search';
export {
  assessCoverage,
  calibrationFor,
  AWAITING_MEASUREMENT,
  rateHit,
  queryNamesDocument,
  uncalibrated,
  CALIBRATIONS,
  DEFAULT_CALIBRATION,
  DEFAULT_MODEL_ID,
  STRONG_MATCH,
  WEAK_FLOOR,
} from './relevance';
export type {
  Coverage,
  CoverageVerdict,
  HitRelevance,
  RelevanceCalibration,
  ScoredHit,
} from './relevance';
export { assessFreshness, describeAge, formatDateEs, isSuperseded } from './freshness';
export type { Freshness, FreshnessStatus } from './freshness';
export {
  CONFLICT_MIN_SIMILARITY,
  NEAR_DUPLICATE_SIMILARITY,
  SAME_EVENT_DAYS,
  extractFigures,
  figuresDiverge,
  findConflicts,
} from './conflicts';
export type { Conflict, ConflictRival, ConflictSourceHit } from './conflicts';
export { ingestMarkdown, OVER_DOCUMENT_LIMIT_MESSAGE } from './ingest';
export { kbListSpaces } from './list-spaces';
export { kbShareSpace } from './share-space';
export { kbCreateDocument } from './create-document';
export { kbContext } from './context';
export {
  assertCanAdminSpace,
  assertCanWriteToSpace,
  atLeast,
  ensurePersonalSpace,
  getVisibleDocument,
  getVisibleSpace,
  grantSpaceAccess,
  isOrgAdmin,
  listSpaceAccess,
  listVisibleSpaces,
  resolveSpaceByName,
  revokeSpaceAccess,
  searchSpaces,
  spaceLevel,
} from './spaces';
export type {
  GrantSubject,
  SearchSpacesOptions,
  Space,
  SpaceGrant,
  SpaceHit,
  SpaceKind,
  SpaceLevel,
  SpaceSummary,
} from './spaces';
