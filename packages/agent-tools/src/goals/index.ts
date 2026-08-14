/**
 * Metas: el número contra el que se compara todo lo demás (migración 0101).
 *
 * Barril deliberadamente estrecho, como el de `payments/` y el de `documents/`.
 * Sale lo que la pantalla y el cron necesitan de verdad; el resto se importa de
 * su propio archivo desde los tests que lo ejercitan.
 *
 * Varios nombres salen con prefijo a propósito. `commitments` ya exporta
 * `bogotaToday`, `daysBetween` y `noticesOwed` por este mismo barril, y dos
 * nombres iguales en `@cortex/agent-tools` son un error de compilación en un
 * archivo que nadie tocó. Dentro del módulo se siguen llamando corto.
 */

// El registro cerrado y el selector que se niega a ofrecer lo que no sabe
// medir. Es la pieza que sostiene el resto del módulo.
export {
  METRIC_CATALOG,
  MetricUnavailableError,
  UnknownMetricError,
  metricByKey,
  offerMetrics,
} from './catalog';
export type {
  MetricAvailability,
  MetricMeasurement,
  MetricOffer,
  MetricSourceSpec,
  MetricSpec,
} from './catalog';

// El vocabulario: unidades, dirección, períodos y el veredicto.
export {
  CADENCES,
  CADENCE_LABEL,
  DIRECTION_LABEL,
  METRIC_DIRECTIONS,
  METRIC_UNITS,
  READING_STATUSES,
  STATUS_LABEL as GOAL_STATUS_LABEL,
  STATUS_TONE as GOAL_STATUS_TONE,
  UNIT_LABEL as GOAL_UNIT_LABEL,
  describeTarget,
  formatValue as formatGoalValue,
  judge as judgeReading,
  lastClosedPeriod,
  periodContaining,
  previousPeriod,
} from './shape';
export type {
  Cadence,
  MetricDirection,
  MetricUnit,
  Period as GoalPeriod,
  ReadingStatus,
} from './shape';

// Lecturas y escrituras, para la pantalla, sus acciones de servidor y el cron.
export {
  archiveGoal,
  claimGoalNotice,
  getGoal,
  goalNoticesOwed,
  hydrateGoals,
  lastMeasuredStatus,
  listGoalNotices,
  listGoals,
  listReadings,
  measureAndRecord,
  measureLive,
  readingFor,
  recordGoalReading,
  releaseGoalNotice,
  settleGoalNotice,
  writeGoal,
} from './store';
export type {
  ClaimNoticeInput,
  ClaimNoticeResult,
  GoalNoticeRow,
  GoalReadingRow,
  GoalRow,
  ListGoalsOptions,
  NoticeClass,
  RecordReadingInput,
  RecordReadingResult,
  WriteGoalInput,
} from './store';
