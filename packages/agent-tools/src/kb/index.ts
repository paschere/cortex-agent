export { parseDocument } from './parsers';
export type { ParseResult } from './parsers';
export { chunkText, approxTokens } from './chunker';
export type { Chunk } from './chunker';
export { chunkTranscript, chunkOffsetMs, formatOffset } from './transcript-chunker';
export type { TranscriptChunk, TranscriptChunkMetadata } from './transcript-chunker';
export { transcribeAudio, mapDeepgramResponse, DEEPGRAM_LISTEN_URL } from './transcribe';
export type { SpeechTurn, Transcript, TranscribeResult, TranscribeFailure } from './transcribe';
export { embedDocuments, embedQuery, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embedder';
export type { EmbedFailure, EmbedResult } from './embedder';
export { kbSearch } from './search';
export {
  assessCoverage,
  rateHit,
  STRONG_MATCH,
  WEAK_FLOOR,
} from './relevance';
export type { Coverage, CoverageVerdict, HitRelevance, ScoredHit } from './relevance';
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
export { kbListSpaces } from './list-spaces';
export { kbCreateDocument } from './create-document';
export { kbContext } from './context';
export {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  getVisibleDocument,
  getVisibleSpace,
  isOrgAdmin,
  listVisibleSpaces,
  resolveSpaceByName,
  searchSpaces,
} from './spaces';
export type { Space, SpaceHit, SpaceKind, SearchSpacesOptions } from './spaces';
