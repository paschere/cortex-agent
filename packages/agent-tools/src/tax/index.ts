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
  taxProfileInputSchema,
} from './shape';
export type {
  GeneratedObligation,
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
