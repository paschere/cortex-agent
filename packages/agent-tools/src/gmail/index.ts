export * from './search';
export * from './read-thread';
export * from './draft';
export * from './send-draft';
export * from './send-message';
export * from './list-threads';
// Lo que convierte el buzón en memoria (migración 0121): archivar un hilo a
// mano, encender el aprendizaje del buzón entero, y preguntar cómo va.
export * from './archive-thread';
export * from './train';
// Sin herramienta encima: los usa el trabajo en segundo plano, no un modelo.
export * from './learn';
export * from './propose-replies';
export * from './sync-state';
export * from './mime';

// RENOMBRADOS AL SALIR, y no por gusto. `../outlook` exporta un `ingestThread`,
// un `threadParticipants` y un `ThreadIngestResult` propios, y dos cosas
// distintas con el mismo nombre en `@cortex/agent-tools` es exactamente cómo se
// archiva un hilo de Gmail con el código de Outlook sin que nadie lo note. Es
// la misma decisión que tomó `clients/index.ts` con su `domainOf`.
export {
  type ThreadIngestOutcome as GmailIngestOutcome,
  type ThreadIngestResult as GmailIngestResult,
  type GmailIngestContext,
  ingestThread as gmailIngestThread,
  buildMailTurns as buildGmailMailTurns,
  buildThreadChunks as buildGmailThreadChunks,
  buildThreadHeader as buildGmailThreadHeader,
} from './ingest-thread';
export {
  type MailMessage,
  type MailboxProfile,
  type BackfillWindow,
  type ThreadPage,
  type HistoryResult,
  BACKFILL_WINDOWS,
  backfillQuery,
  fetchProfile,
  fetchThreadMessages,
  gmailDate,
  listHistoryThreadIds,
  listThreadPage,
  normalizeMessage,
  threadParticipants as gmailThreadParticipants,
} from './threads';
