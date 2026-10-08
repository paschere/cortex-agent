/**
 * Automatizaciones de las aplicaciones (migración 0210): disparadores de fila,
 * formulario, aprobación, horario y botón; condiciones como las de las vistas;
 * acciones de avisos, filas, webhook y Cortex. Ver docs/features/apps.md.
 */

export * from './spec';
export * from './match';
export * from './ask';
export * from './limits';
export * from './poll';
export * from './poll-run';
export * from './waits';
export {
  type AutomationLimits,
  DEFAULT_AUTOMATION_LIMITS,
  MAX_AUTOMATION_LIMITS,
  resolveLimits,
  APP_DAILY_ASK_CORTEX_CAP,
  APP_DAILY_EMAIL_CAP,
  APP_DAILY_RUN_CAP,
  MAX_ATTEMPTS,
  type ActionPreview,
  type ConditionResult,
  type Simulation,
  type TemplateContext,
  TransientActionError,
  backoffMs,
  evaluateConditions,
  isTransient,
  previewActions,
  renderTemplate,
  renderValues,
  scheduleDue,
  scheduleSlotStart,
  simulateRule,
  variablesIn,
} from './engine';
export {
  type AutomationOrigin,
  type EmitInput,
  currentAutomationOrigin,
  emitAutomationEvent,
  emitSyncEvents,
  forgetAutomationWatch,
  queueRuns,
  setAutomationWaker,
  watchesTracker,
  withAutomationOrigin,
} from './emit';
export * from './store';
export * from './run';
export * from './templates';
export { simulateAutomation } from './simulate';
export {
  appsAutomationsCreate,
  appsAutomationsList,
  appsAutomationsPause,
  appsAutomationsUpdate,
  describeAutomation,
} from './tools';
