/**
 * El piloto automático (migración 0176): cada mañana Cortex arma el plan del
 * día de una empresa, hace lo rutinario que tiene permitido y le deja al dueño
 * una lista corta con lo que necesita su decisión.
 *
 *   types.ts          el vocabulario: áreas, niveles, decisiones, estados
 *   settings.ts       la configuración por empresa y si hoy toca correr
 *   collectors.ts     de la fotografía de la mañana a «cosas del día» (puros)
 *   policy.ts         hacer, preguntar o contar (puro)
 *   plan.ts           recolectar + historia + política: el plan
 *   run.ts            la corrida, con sus garantías (dependencias inyectadas)
 *   sources.ts        la fotografía, una lectura aislada por fuente
 *   store.ts          configuración, corridas y cosas en la base
 *   engine.ts         las piezas de planear, iguales para chat, ensayo y corrida
 *   format.ts         el plan en texto para el chat
 *   routine-tools.ts  autopilot.remind, trackers.retry_sync, ledger.categorize_pending
 *   tools.ts          autopilot.plan / status / configure
 */

import './routine-tools';
import './tools';

export * from './types';
export * from './settings';
export {
  type AutopilotSnapshot,
  collectAll,
  draftInvoiceCollection,
  money as autopilotMoney,
} from './collectors';
export * from './policy';
export * from './plan';
export * from './run';
export { loadSnapshot as loadAutopilotSnapshot, SOURCE_LABEL } from './sources';
export * from './store';
export * from './engine';
export * from './format';
