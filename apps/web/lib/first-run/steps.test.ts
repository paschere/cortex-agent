import { describe, expect, it } from 'vitest';
import {
  type FirstRunFacts,
  buildFlow,
  resolveStep,
  shouldShowFirstRun,
  timePromise,
} from './steps';

const none: FirstRunFacts = {
  modulesAnswered: false,
  googleConnected: false,
  accountingConnected: false,
  whatsappConnected: false,
  interviewState: 'none',
  autopilotEnabled: false,
};

describe('buildFlow', () => {
  it('empresa nueva: primer paso actual, 0% y promesa de 15 min', () => {
    const f = buildFlow(none);
    expect(f.current).toBe('empresa');
    expect(f.percent).toBe(0);
    expect(f.minutesLeft).toBe(15);
    expect(timePromise(f)).toContain('15');
    expect(shouldShowFirstRun(f)).toBe(true);
  });

  it('cualquier fuente cuenta como paso 2 hecho', () => {
    for (const k of ['googleConnected', 'accountingConnected', 'whatsappConnected'] as const) {
      const f = buildFlow({ ...none, modulesAnswered: true, [k]: true });
      expect(f.steps[1]?.status).toBe('done');
      expect(f.current).toBe('cuentale');
    }
  });

  it('una entrevista propuesta pero sin aplicar no cierra el paso 3', () => {
    const f = buildFlow({
      ...none,
      modulesAnswered: true,
      googleConnected: true,
      interviewState: 'proposed',
    });
    expect(f.current).toBe('cuentale');
    expect(f.percent).toBe(50);
  });

  it('todo hecho: completo, sin recorrido y paso final por defecto', () => {
    const f = buildFlow({
      modulesAnswered: true,
      googleConnected: true,
      accountingConnected: false,
      whatsappConnected: false,
      interviewState: 'applied',
      autopilotEnabled: true,
    });
    expect(f.complete).toBe(true);
    expect(f.percent).toBe(100);
    expect(f.current).toBeNull();
    expect(shouldShowFirstRun(f)).toBe(false);
    expect(resolveStep(undefined, f)).toBe('resumen');
  });

  it('la guía completa fuerza ocultar el recorrido', () => {
    expect(shouldShowFirstRun(buildFlow(none), { full: true })).toBe(false);
  });
});

describe('resolveStep', () => {
  it('respeta un paso válido y cae al actual si no', () => {
    const f = buildFlow({ ...none, modulesAnswered: true });
    expect(resolveStep('resumen', f)).toBe('resumen');
    expect(resolveStep('nada', f)).toBe('fuentes');
    expect(resolveStep(undefined, f)).toBe('fuentes');
  });
});
