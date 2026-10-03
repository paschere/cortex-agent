/**
 * Atención a clientes por WhatsApp (migración 0185). Lee `handler.ts` primero:
 * el orden de las decisiones es el diseño.
 */
import './tools';

export { whatsappCustomerConversations, whatsappReply } from './tools';
export * from './shape';
export {
  classify as classifyCustomerMessage,
  describeHours,
  extractInvoiceNumber,
  extractNit,
  extractOrderNumber,
  fold as foldCustomerText,
  isOptIn,
  isOptOut,
  isWithinHours,
  matchFaq,
  matchPhone,
  nextOpening,
  normalizeReference,
  sameReference,
  samePhone,
  underRateLimit,
} from './classify';
export type {
  Classification as CustomerClassification,
  PhoneContact,
  PhoneMatch,
} from './classify';
export {
  balanceAnswer,
  greetingAnswer,
  handoffAnswer,
  invoicesAnswer,
  orderAnswer,
  spokenDate,
} from './answers';
export type { Answer, OrderFact } from './answers';
export { MAX_VERIFY_ATTEMPTS, handleCustomerMessage, verificationClaim } from './handler';
export type {
  CustomerDeps,
  CustomerOutcome,
  EscalationReason,
  InboundCustomerMessage,
  RecentReply,
} from './handler';
export {
  ackOutbox,
  claimOutbox,
  closeConversation,
  customerDeps,
  escalateConversation,
  findOrder,
  getConversation,
  listConversationMessages,
  listCustomerConversations,
  loadCustomerSettings,
  queueHumanReply,
  rowIsClient,
  saveCustomerSettings,
  verifyClaim,
} from './store';
export type { ConversationListItem, EscalationResult, OutboxItem } from './store';
