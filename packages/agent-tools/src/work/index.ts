/**
 * El registro de trabajo (migración 0174): quién tiene que hacer qué, quién lo
 * hizo y cuándo, llenado desde Gerencia, compromisos, tablas, aprobaciones y lo
 * que cualquiera registre. Mide trabajo, no personas.
 *
 *   types.ts         el contrato entre el registro y las métricas
 *   shape.ts         vocabulario, ajustes, quién es quién
 *   adapters.ts      de cada fuente a un ítem (puros)
 *   store.ts         lectura y escritura idempotente
 *   access.ts        quién ve el trabajo de quién
 *   sync.ts          la sincronización incremental (`syncWork`)
 *   metrics.ts       las cifras de cada persona (motor puro)
 *   signals.ts       lo que vale la pena mirar (motor puro)
 *   report.ts        el reporte del equipo y «mi semana» (motor puro)
 *   tools.ts         work.* en el chat
 *   view-sources.ts  `cortex.trabajo` y `cortex.equipo` en las vistas
 */

import './tools';

export * from './types';
export * from './shape';
export * from './adapters';
export * from './store';
export * from './access';
export * from './sync';
export * from './metrics';
// `previousPeriod` también lo exporta ./goals con otro significado (el período
// de una meta): en la raíz del paquete manda el de metas; el del trabajo se
// alcanza con este nombre.
export { previousPeriod as previousWorkPeriod } from './metrics';
export * from './signals';
export * from './report';
export * from './view-sources';
export {
  workAssign,
  workConfigure,
  workPreviewBatch,
  workQuery,
  workRecord,
  workRecordBatch,
  workSuggestMapping,
  workUpdatePerson,
} from './tools';
