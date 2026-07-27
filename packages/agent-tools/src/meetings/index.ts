// Side-effect imports register each tool with the registry at module load.
import './get-transcript';
import './list-transcripts';
import './prepare-briefing';
import './schedule-briefings';

export { meetingsGetTranscript } from './get-transcript';
export { meetingsListTranscripts } from './list-transcripts';
export { meetingsPrepareBriefing } from './prepare-briefing';
export { meetingsScheduleBriefings } from './schedule-briefings';

export {
  MEET_READONLY_SCOPE,
  fetchSpaceMeetingCode,
  fetchTranscriptText,
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
  TranscriptRef,
  TranscriptText,
} from './client';
