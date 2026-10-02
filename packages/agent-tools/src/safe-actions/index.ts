// Acciones seguras de repetir (migración 0168): idempotencia y verificación
// posterior de las herramientas con efectos. Ver docs/features/safe-actions.md.
//
// `canonicalize`/`canonicalJson` NO salen del paquete: hay homónimos en
// ./actions y ./reports, y la huella sólo se calcula aquí dentro.
export { idempotencyKey } from './canonical';
export { SAFE_ACTION_CATALOG } from './catalog';
export {
  ActionInFlightError,
  ActionOutcomeUnknownError,
  DEFAULT_WINDOW_MS,
  REPEAT_FLAG,
} from './runtime';
export { findPriorAction } from './prior';
export type { PriorAction } from './prior';
export type {
  ActionRow as SafeActionRow,
  ActionStatus as SafeActionStatus,
  SafeActionPolicy,
  VerifyOutcome,
  VerifyStatus,
} from './types';
