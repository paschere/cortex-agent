import { describe, expect, it } from 'vitest';
// Ruta relativa y no alias: el manifiesto vive FUERA de apps/web a propósito
// (el worker de Railway se construye sin conocer el monorepo), y este test es
// el único punto donde las dos mitades se miran a la cara.
import { JOBS } from '../../../services/jobs/src/manifest';
import { JOB_HANDLERS } from './jobs-registry';

/**
 * EL ESPEJO. El worker (services/jobs) encola y programa por NOMBRE; la app
 * ejecuta buscando ese nombre en el registro. Ninguno de los dos puede ver al
 * otro en tiempo de ejecución, así que la única manera de que no diverjan es
 * que este test lo impida en CI:
 *
 *   (a) un nombre del manifiesto sin handler = un cron que dispara y el puente
 *       responde «sin handler» para siempre, sin que nada se caiga;
 *   (b) un handler que el manifiesto no conoce = trabajo que se encola hacia
 *       una cola que el worker jamás creó, o código muerto que miente.
 *
 * Ambos son silenciosos en producción. Aquí son un fallo rojo con nombre.
 */
describe('jobs registry ↔ manifest', () => {
  const manifestNames = JOBS.map((j) => j.name);
  const registryNames = Object.keys(JOB_HANDLERS);

  it('todo nombre del manifiesto tiene handler en la app', () => {
    const missing = manifestNames.filter((name) => !(name in JOB_HANDLERS));
    expect(
      missing,
      'Estos trabajos existen en services/jobs/src/manifest.ts pero no en lib/jobs-registry.ts: el worker los va a disparar y el puente los va a descartar.',
    ).toEqual([]);
  });

  it('todo handler del registro existe en el manifiesto', () => {
    const manifest = new Set(manifestNames);
    const orphans = registryNames.filter((name) => !manifest.has(name));
    expect(
      orphans,
      'Estos handlers no aparecen en services/jobs/src/manifest.ts: nadie los va a invocar nunca, o alguien encola hacia una cola que el worker no creó.',
    ).toEqual([]);
  });

  it('el manifiesto no repite nombres', () => {
    expect(new Set(manifestNames).size).toBe(manifestNames.length);
  });

  it('cada entrada del registro es una función', () => {
    for (const [name, handler] of Object.entries(JOB_HANDLERS)) {
      expect(typeof handler, `El handler de "${name}" no es una función`).toBe('function');
    }
  });
});
