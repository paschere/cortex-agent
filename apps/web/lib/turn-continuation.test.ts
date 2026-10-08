import { describe, expect, it } from 'vitest';
import {
  continuationNudge,
  maxStepsFor,
  promisesAction,
  shouldContinue,
} from './turn-continuation';

describe('un turno que termina en una promesa', () => {
  it('EL CASO DE PRODUCCIÓN: «Ahora diseño la app completa.»', () => {
    expect(
      promisesAction(
        'Las tres tablas ya están confirmadas y conectadas. Ahora diseño la app completa.',
      ),
    ).toBe(true);
  });
  it('otros anuncios en primera persona', () => {
    expect(promisesAction('Listo el inventario. Voy a crear la tabla con esos campos.')).toBe(true);
    expect(promisesAction('Perfecto. A continuación te la conecto:')).toBe(true);
    expect(promisesAction('Procedo a sincronizar la hoja.')).toBe(true);
  });
  it('no confunde un cierre legítimo con una promesa', () => {
    expect(promisesAction('¿La creo así o quieres cambiar algo?')).toBe(false);
    expect(promisesAction('Si quieres, ahora la conecto.')).toBe(false);
    expect(promisesAction('Quedó en Tablas → Guías.')).toBe(false);
    expect(promisesAction('Ahora todo está listo.')).toBe(false);
    expect(promisesAction('Voy a necesitar que me confirmes el campo clave?')).toBe(false);
    expect(promisesAction('')).toBe(false);
  });
  it('mira sólo el final: un «voy a» en medio no cuenta', () => {
    expect(promisesAction('Voy a explicarte. La tabla tiene 3 columnas y quedó creada.')).toBe(
      false,
    );
  });
});

describe('la continuación automática', () => {
  const base = {
    lastStepText: 'Ahora diseño la app completa.',
    lastStepHadTools: false,
    finishReason: 'stop',
    stepsUsed: 3,
    maxSteps: 26,
    pastSoft: false,
    alreadyContinued: false,
  };
  it('una sola vez, sólo con tiempo', () => {
    expect(shouldContinue(base)).toBe('promise');
    expect(shouldContinue({ ...base, alreadyContinued: true })).toBeNull();
    expect(shouldContinue({ ...base, pastSoft: true })).toBeNull();
  });
  it('pasos agotados con herramientas sin comentar → cerrar con resumen', () => {
    expect(
      shouldContinue({
        ...base,
        stepsUsed: 26,
        lastStepHadTools: true,
        finishReason: 'tool-calls',
      }),
    ).toBe('steps');
  });
  it('un cierre normal no continúa', () => {
    expect(shouldContinue({ ...base, lastStepText: 'Quedó creada.' })).toBeNull();
  });
  it('el empujón cita lo prometido y pasos proporcionales al presupuesto', () => {
    expect(continuationNudge('promise', 'Ahora diseño la app.')).toContain('Ahora diseño la app.');
    expect(maxStepsFor(800_000)).toBe(27);
    expect(maxStepsFor(300_000)).toBe(12);
  });
});
