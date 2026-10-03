/**
 * Los derechos del titular (Ley 1581 art. 8) y qué clase de solicitud es cada
 * uno. Sin imports de servidor: el formulario (cliente) y la ruta comparten la
 * misma lista.
 */
import type { LegalRequestKind } from './deadlines';

export const LEGAL_RIGHTS = [
  'conocer',
  'actualizar',
  'rectificar',
  'suprimir',
  'revocar',
  'prueba',
  'informacion_uso',
  'otro',
] as const;
export type LegalRight = (typeof LEGAL_RIGHTS)[number];

export const LEGAL_RIGHT_LABEL: Readonly<Record<LegalRight, string>> = {
  conocer: 'Conocer qué datos míos tienen',
  actualizar: 'Actualizar mis datos',
  rectificar: 'Rectificar datos incorrectos',
  suprimir: 'Suprimir mis datos',
  revocar: 'Revocar la autorización',
  prueba: 'Pedir prueba de mi autorización',
  informacion_uso: 'Saber para qué se han usado mis datos',
  otro: 'Otro',
};

/**
 * Qué clase de solicitud es cada derecho. Conocer y pedir información son
 * consultas (art. 14); corregir, suprimir o revocar son reclamos (art. 15).
 */
export function kindForRight(right: LegalRight): LegalRequestKind {
  return right === 'conocer' ||
    right === 'prueba' ||
    right === 'informacion_uso' ||
    right === 'otro'
    ? 'consulta'
    : 'reclamo';
}
