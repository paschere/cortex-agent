/**
 * El calendario tributario de Colombia (migración 0180): el perfil tributario
 * de la empresa, el motor puro que saca las fechas del año, la sincronización
 * con los vencimientos y las tres herramientas del chat (`tax.calendar`,
 * `tax.configure`, `tax.mark`).
 */
export {
  RULE_VERSION,
  RULE_VERSION_BY_YEAR,
  VERIFIED_DIAN_2026,
  calendarFor,
  isTaxBusinessDay,
  nthBusinessDay,
  supportedYears,
  taxHolidays,
} from './calendar-co';
export { buildTaxCalendar, generateObligations, pilaBusinessDay } from './engine';
export type { TaxCalendarResult } from './engine';
export {
  ICA_CITIES,
  ICA_CITY_LABEL,
  ICA_PERIODICITIES,
  IVA_PERIODICITIES,
  OBLIGATION_KINDS,
  OBLIGATION_KIND_LABEL,
  OBLIGATION_STATUSES,
  OBLIGATION_STATUS_LABEL,
  PERSON_TYPES,
  isFulfilled,
  lastDigit,
  lastTwoDigits,
  nitCheckDigit,
  splitNit,
  spanishDay,
  icaActivitySchema,
  taxProfileInputSchema,
} from './shape';
export type {
  GeneratedObligation,
  IcaActivityProfile,
  IcaCity,
  IcaPeriodicity,
  IvaPeriodicity,
  ObligationKind,
  ObligationStatus,
  PersonType,
  TaxObligation,
  TaxProfile,
  TaxProfileInput,
} from './shape';
export {
  canMarkTaxObligations,
  getTaxObligation,
  listTaxObligations,
  normalizeProfileInput,
  readTaxProfile,
  saveTaxProfile,
} from './store';
export type { ListObligationsOptions, MarkObligationInput } from './store';
export { TAX_SOURCE_SYSTEM, markTaxObligation, planTaxSync, syncTaxCalendar } from './sync';
export type { MarkResult, TaxSyncPlan, TaxSyncResult } from './sync';
export { taxCalendar, taxConfigure, taxMark } from './tools';

// Borradores para el contador, certificados de retención y exógena (0197).
export {
  DRAFTABLE_OBLIGATION_KINDS,
  DRAFT_DISCLAIMER,
  DRAFT_FORM,
  DRAFT_KINDS,
  DRAFT_KIND_LABEL,
  DRAFT_STATUSES,
  DRAFT_STATUS_LABEL,
  allLines as draftLines,
} from './draft-shape';
export type {
  DraftFigures,
  DraftKind,
  DraftLine,
  DraftPeriod,
  DraftResult,
  DraftSection,
  DraftStatus,
  DraftTarget,
  MissingItem as DraftMissingItem,
  SourceRef as DraftSourceRef,
} from './draft-shape';
export {
  buildIcaDraft,
  buildIvaDraft,
  buildRentaDraft,
  buildRetencionDraft,
  buildSimpleAnticipoDraft,
  draftMarkdown,
  draftTargetFor,
} from './drafts';
export type { IcaActivity } from './drafts';
export {
  buildDraftFromData,
  readPurchases as readTaxPurchases,
  readReceivables as readTaxReceivables,
  readSales as readTaxSales,
} from './draft-sources';
export {
  annulTaxDraft,
  draftStatusByObligation,
  getTaxDraft,
  issueCertificate,
  listCertificateRecords,
  liveDraftFor,
  markDraftPresented,
  markDraftReviewed,
  saveTaxDraft,
  setSupplierWithholdingConcept,
} from './draft-store';
export type { CertificateRecord, TaxDraftRecord } from './draft-store';
export {
  CERTIFICATE_KINDS,
  CERTIFICATE_KIND_LABEL,
  bimesterOf,
  buildWithholdingCertificates,
  certificateFileName,
  certificatePeriodLabel,
} from './certificates';
export type { CertificateKind, WithholdingCertificate } from './certificates';
export {
  CONCEPT_1001,
  EXOGENA_FORMATS,
  EXOGENA_FORMAT_LABEL,
  buildExogena,
  exogenaCsv,
} from './exogena';
export type { ExogenaFormat, ExogenaFormatCode } from './exogena';
export { renderCertificatePdf, renderDraftPdf } from './pdf';
export {
  PATRIMONIO_THRESHOLD_UVT,
  TAX_RATES_VERSION,
  WITHHOLDING_CONCEPTS,
  WITHHOLDING_CONCEPT_LABEL,
  patrimonioTest,
  transferPricingTest,
  uvtFor,
  withholdingRate,
} from './rates-co';
export type { WithholdingConcept } from './rates-co';
export {
  loadCertificates,
  taxCertificates,
  taxCertificatesInput,
  taxDraft,
  taxExogenaExport,
} from './draft-tools';
