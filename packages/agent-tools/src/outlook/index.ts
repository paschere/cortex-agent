export * from './attachments';
export * from './search';
export * from './read-thread';
export * from './draft';
export * from './send-draft';
export * from './list-threads';
export * from './archive-thread';

export {
  buildMailTurns,
  buildThreadChunks,
  buildThreadHeader,
  classifyAudience,
  counterpartDomainOf,
  domainOf,
  ingestThread,
  matchClientByDomain,
  messageAddresses,
} from './ingest-thread';
export type {
  OutlookIngestContext,
  ThreadAudience,
  ThreadIngestOutcome,
  ThreadIngestResult,
} from './ingest-thread';

export {
  fetchConversation,
  fetchMessages,
  groupByConversation,
  messageBudget,
  messageMoment,
  threadParticipants,
} from './threads';
export type { ThreadRow } from './threads';
