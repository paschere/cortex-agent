// Side-effect imports register each tool with the registry at module load.
import './get-transcript';
import './import-transcript';
import './list-transcripts';
import './prepare-briefing';
import './schedule-briefings';

export { meetingsGetTranscript } from './get-transcript';
export { meetingsJoinLive } from './join-live';
export { meetingsLiveStatus } from './live-status';
export { meetingsImportTranscript } from './import-transcript';
export { meetingsListTranscripts } from './list-transcripts';
export { meetingsPrepareBriefing } from './prepare-briefing';
export { meetingsScheduleBriefings } from './schedule-briefings';

// The importer's engine, for the callers that are not a model turn: the Inngest
// sweep and the Brain Knowledge page's manual import button.
export {
  buildChunks,
  buildHeader,
  buildSpeechTurns,
  importMeetingTranscript,
} from './import-transcript';
export type {
  ImportMeetingOptions,
  MeetingImportContext,
  MeetingImportOutcome,
  MeetingImportResult,
} from './import-transcript';

export {
  MEET_READONLY_SCOPE,
  fetchSpaceMeetingCode,
  fetchTranscriptEntries,
  fetchTranscriptText,
  getConferenceRecord,
  listConferenceRecords,
  listParticipants,
  listTranscripts,
  meetCodeVariants,
  pickTranscript,
  recordDurationMinutes,
} from './client';
export type {
  ConferenceRecord,
  MeetParticipant,
  TranscriptEntry,
  TranscriptRef,
  TranscriptText,
} from './client';
