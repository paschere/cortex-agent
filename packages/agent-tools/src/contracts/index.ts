/**
 * Contratos (migración 0195): borradores desde plantillas para revisión de un
 * abogado, copias firmadas, obligaciones leídas con su frase y confirmadas por
 * una persona, y el aviso previo vigilado.
 *
 * Barril ESTRECHO y con nombres propios: todo cae en `@cortex/agent-tools`
 * junto a otros cuarenta módulos, y dos `plural` o dos `STATUS_LABEL` en la
 * raíz son un error de compilación en un archivo que nadie tocó.
 */

// Registro de las herramientas (por importarlas).
export {
  contractsDraft,
  contractsExtractObligations,
  contractsList,
  contractsObligations,
} from './tools';

export {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABEL,
  CONTRACT_STATUS_TONE,
  CONTRACT_TYPES as LEGAL_CONTRACT_TYPES,
  CONTRACT_TYPE_LABEL as LEGAL_CONTRACT_TYPE_LABEL,
  COUNTERPARTY_KINDS as CONTRACT_COUNTERPARTY_KINDS,
  COUNTERPARTY_KIND_LABEL as CONTRACT_COUNTERPARTY_KIND_LABEL,
  DRAFT_BANNER as CONTRACT_DRAFT_BANNER,
  DRAFT_NOTICE as CONTRACT_DRAFT_NOTICE,
  OBLIGATION_CATEGORIES as CONTRACT_OBLIGATION_CATEGORIES,
  OBLIGATION_CATEGORY_LABEL as CONTRACT_OBLIGATION_CATEGORY_LABEL,
  OBLIGATION_PARTIES as CONTRACT_OBLIGATION_PARTIES,
  OBLIGATION_PARTY_LABEL as CONTRACT_OBLIGATION_PARTY_LABEL,
  OBLIGATION_RECURRENCES as CONTRACT_OBLIGATION_RECURRENCES,
  OBLIGATION_RECURRENCE_LABEL as CONTRACT_OBLIGATION_RECURRENCE_LABEL,
  OBLIGATION_STATUS_LABEL as CONTRACT_OBLIGATION_STATUS_LABEL,
  RENEWALS as CONTRACT_RENEWALS,
  RENEWAL_LABEL as CONTRACT_RENEWAL_LABEL,
  canSeeContract,
  contractTerm,
  deriveContractStatus,
  isSensitiveContract,
} from './shape';
export type {
  ContractEventRow,
  ContractRow,
  ContractStatus,
  ContractTerm,
  ContractType as LegalContractType,
  CounterpartyKind as ContractCounterpartyKind,
  ObligationCategory as ContractObligationCategory,
  ObligationParty as ContractObligationParty,
  ObligationRecurrence as ContractObligationRecurrence,
  ObligationRow as ContractObligationRow,
  Renewal as ContractRenewal,
} from './shape';

export {
  BUILTIN_TEMPLATES as CONTRACT_TEMPLATES,
  builtinTemplate as contractTemplate,
  fillTemplate as fillContractTemplate,
  remainingPlaceholders as contractPlaceholders,
} from './templates';
export type {
  ContractTemplate,
  FillContext as ContractFillContext,
  FillResult as ContractFillResult,
  TemplateField as ContractTemplateField,
} from './templates';

export { longSpanishDate, numberToSpanish, pesosInWords } from './text';

export {
  CONTRACT_LIST_COLUMNS,
  getContract,
  listCompanyTemplates as listCompanyContractTemplates,
  listContractEvents,
  listContracts,
  listObligations as listContractObligations,
  loadContractNames,
  saveCompanyTemplate as saveCompanyContractTemplate,
} from './store';
export type { CompanyTemplateRow as CompanyContractTemplateRow } from './store';

export {
  addManualObligation as addManualContractObligation,
  applyReadTerm as applyContractReadTerm,
  buildFillContext as buildContractFillContext,
  completeObligation as completeContractObligation,
  confirmObligation as confirmContractObligation,
  discardObligation as discardContractObligation,
  draftContract,
  editContractText,
  extractContractObligations,
  markSigned as markContractSigned,
  registerUploadedContract,
  resolveTemplate as resolveContractTemplate,
  sendToReview as sendContractToReview,
  syncContractWatch,
  terminateContract,
  updateContractTerm,
} from './ops';
export type {
  CounterpartyLink as ContractCounterpartyLink,
  DraftInput as ContractDraftInput,
  ExtractResult as ContractExtractResult,
  TermPatch as ContractTermPatch,
  WatchResult as ContractWatchResult,
} from './ops';

export { renderContractDocx, renderContractPdf } from './document';
export type { ContractBrand } from './document';

export { adaptContract, adaptObligation as adaptContractObligation } from './view';
export type { ContractView, ObligationView as ContractObligationView } from './view';

export {
  CONTRACT_NOTICE_WINDOW_DAYS,
  collectContractNotices,
  loadContractSnapshot,
} from './autopilot';
export type { SnapshotContractNotice } from './autopilot';
