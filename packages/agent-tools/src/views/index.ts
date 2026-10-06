/**
 * Vistas: pantallas que la empresa se arma hablando (migración 0156).
 *
 * Bloques declarativos sobre las tablas inventadas de la 0115 y, en sólo
 * lectura, sobre las fuentes de la plataforma (sources.ts) y las tablas del
 * Feed de quien mira (feed-sources.ts). El agente las
 * crea y las edita; la persona las ve adentro, en Inicio o por un enlace.
 */

import './tools';
import './pulse-tools';
import './pulse-weekly';

export {
  viewsArchive,
  viewsCreate,
  viewsGet,
  viewsList,
  viewsShare,
  viewsUpdate,
} from './tools';
export {
  viewsCompanyPulse,
  viewsRefreshSummary,
  viewsSchedulePulse,
  pulseRoutineInput,
  readPulseInventory,
  refreshViewSummary,
  summaryWrittenOn,
  modelSummaryWriter,
  type RefreshOutcome,
  type RefreshOptions,
  type SummaryWriter,
} from './pulse-tools';
export * from './pulse';
export * from './pulse-history';
export { readPulseSnapshots, savePulseSnapshot } from './pulse-snapshots';
export {
  viewsWeeklyReview,
  viewsScheduleWeeklyReview,
  weeklyRoutineInput,
  runWeeklyReview,
  readWeeklyActivity,
  weeklyWrittenOn,
  modelWeeklyWriter,
  type WeeklyOutcome,
  type WeeklyOptions,
  type WeeklyWriter,
  type ActivityWindow,
} from './pulse-weekly';

export * from './spec';
export * from './compute';
export * from './export';
export * from './digest';
export * from './store';
export * from './sources';
export * from './feed-sources';
export * from './embeds';
export * from './view-filters';
