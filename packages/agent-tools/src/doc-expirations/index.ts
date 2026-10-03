/**
 * Documentos que vencen (migración 0184): el SOAT, la póliza, la licencia, el
 * permiso, el contrato — leídos de los documentos del Cerebro con la frase que
 * dice cada fecha, confirmados por una persona y vigilados como vencimientos.
 *
 * Barril ESTRECHO y con nombres propios: todo lo de aquí cae en
 * `@cortex/agent-tools` junto a otros cuarenta módulos, y dos `hydrate` o dos
 * `STATUS_LABEL` en la raíz son un error de compilación en un archivo que
 * nadie tocó. Lo interno (prompts, la puerta de verificación) lo importan las
 * pruebas desde su archivo.
 */

// Registro de las herramientas (por importarlas).
export { documentsConfirmExpiration, documentsExpiring, documentsTrackExpiration } from './tools';

export {
  CONFIDENCE_LABEL as EXPIRATION_CONFIDENCE_LABEL,
  DEFAULT_LEAD_DAYS as EXPIRATION_DEFAULT_LEAD_DAYS,
  EXPIRATION_KINDS,
  EXPIRATION_KIND_LABEL,
  EXPIRATION_STATUSES,
  STATUS_LABEL as EXPIRATION_STATUS_LABEL,
  STATUS_TONE as EXPIRATION_STATUS_TONE,
  SUBJECT_KINDS as EXPIRATION_SUBJECT_KINDS,
  SUBJECT_KIND_LABEL as EXPIRATION_SUBJECT_KIND_LABEL,
  daysPhrase as expirationDaysPhrase,
  deriveExpirationStatus,
} from './kinds';
export type {
  Confidence as ExpirationConfidence,
  ExpirationKind,
  ExpirationStatus,
  SubjectKind as ExpirationSubjectKind,
} from './kinds';

export { adaptExpiration, evidenceSentence as expirationEvidenceSentence } from './shape';
export type { Expiration } from './shape';

export {
  getExpiration,
  hydrate as hydrateExpirations,
  listExpirations,
} from './store';
export type { ExpirationRow, ListExpirationsOptions } from './store';

export {
  changeExpiration,
  confirmExpiration,
  discardExpiration,
  queueRenewalUpload,
  trackExpiration,
} from './ops';
export type { DecisionResult as ExpirationDecision } from './ops';

export { backfillDocumentExpirations, detectDocumentExpiration } from './ingest';
export type { BackfillResult as ExpirationBackfillResult, DetectionOutcome } from './ingest';
