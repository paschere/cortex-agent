/**
 * Vistas: pantallas que la empresa se arma hablando (migración 0156).
 *
 * Bloques declarativos sobre las tablas inventadas de la 0115 y, en sólo
 * lectura, sobre las fuentes de la plataforma (sources.ts) y las tablas del
 * Feed de quien mira (feed-sources.ts). El agente las
 * crea y las edita; la persona las ve adentro, en Inicio o por un enlace.
 */

import './tools';

export {
  viewsArchive,
  viewsCreate,
  viewsGet,
  viewsList,
  viewsShare,
  viewsUpdate,
} from './tools';

export * from './spec';
export * from './compute';
export * from './store';
export * from './sources';
export * from './feed-sources';
