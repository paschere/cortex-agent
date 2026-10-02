/**
 * PERSEGUIR LO PENDIENTE Y APRENDER DE LO QUE SE RECOMIENDA (migración 0177).
 *
 *   group.ts          aprobaciones parecidas: «Aprobar las 6» (puro)
 *   aging.ts          lo que lleva días esperando tu visto bueno (puro)
 *   digest.ts         el resumen diario de vencidos por persona (puro)
 *   resolve.ts        «Que Cortex lo resuelva»: el siguiente paso seguro (puro)
 *   notices-store.ts  el libro de recordatorios y el interruptor por empresa
 *
 *   recommendations/
 *     shape.ts    vocabulario: tipos, sujetos, efectos
 *     sources.ts  de cada fuente a una recomendación con sujeto (puro)
 *     judge.ts    ¿se siguió? ¿qué pasó después? (puro)
 *     rank.ts     la tasa de acierto por tipo y el orden acotado (puro)
 *     report.ts   «Lo que recomendé y qué pasó», con reglas (puro)
 *     store.ts    lectura y escritura, y la bolsa de hechos
 *     weekly.ts   lo que la revisión semanal aprende y recuerda
 *     tools.ts    recommendations.list
 */

import './recommendations/tools';

export * from './group';
export * from './aging';
export * from './digest';
export * from './resolve';
export * from './notices-store';
export * from './recommendations/shape';
export * from './recommendations/sources';
export * from './recommendations/judge';
export * from './recommendations/rank';
export * from './recommendations/report';
export * from './recommendations/store';
export * from './recommendations/weekly';
export { recommendationsList } from './recommendations/tools';
