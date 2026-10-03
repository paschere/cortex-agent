import { describe, expect, it } from 'vitest';
import {
  autopilotState,
  mailState,
  memoryState,
  modulesState,
  notificationsState,
  planState,
  versionState,
} from './state-text';

describe('el dato corto de cada ajuste', () => {
  it('dice el plan con los días de la prueba', () => {
    expect(planState('Equipo', { status: 'trialing', daysLeft: 9 }).text).toBe(
      'Plan Equipo · prueba: 9 días',
    );
    expect(planState('Equipo', { status: 'trialing', daysLeft: 1 }).text).toBe(
      'Plan Equipo · prueba: 1 día',
    );
  });

  it('avisa en ámbar cuando la prueba se acaba y en rojo cuando quedó en solo lectura', () => {
    expect(planState('Equipo', { status: 'trialing', daysLeft: 2 }).tone).toBe('amber');
    expect(planState('Equipo', { status: 'grace', daysLeft: 0 }).tone).toBe('rose');
    expect(planState('Equipo', { status: 'active', daysLeft: 20 }).text).toBe(
      'Plan Equipo · al día',
    );
  });

  it('sin lectura de cobro, sólo el nombre del plan', () => {
    expect(planState('Equipo', null).text).toBe('Plan Equipo');
  });

  it('cuenta módulos en singular y plural', () => {
    expect(modulesState(7).text).toBe('7 módulos prendidos');
    expect(modulesState(1).text).toBe('1 módulo prendido');
  });

  it('el correo dice en qué punto está', () => {
    expect(mailState(false, null).text).toBe('Google sin conectar');
    expect(mailState(true, null).text).toBe('Google conectado · sin aprender');
    expect(mailState(true, { paused: false, lastError: null }).tone).toBe('emerald');
    expect(mailState(true, { paused: true, lastError: null }).text).toBe('Aprendizaje en pausa');
    expect(mailState(true, { paused: false, lastError: 'x' }).tone).toBe('rose');
  });

  it('la memoria pone primero lo que espera revisión', () => {
    expect(memoryState(4, 0).text).toBe('4 recuerdos');
    expect(memoryState(0, 0).text).toBe('Todavía nada');
    expect(memoryState(4, 2)).toEqual({ text: '2 por revisar', tone: 'amber' });
  });

  it('avisos, piloto y versión', () => {
    expect(
      notificationsState({ digestEnabled: true, digestTime: '07:00', mailAlertsEnabled: true })
        .text,
    ).toBe('Resumen a las 07:00 · avisos del correo prendidos');
    expect(autopilotState(true, 7).text).toBe('Prendido · 07:00');
    expect(autopilotState(false, 7).text).toBe('Apagado');
    expect(versionState('abcdef123456').text).toBe('Versión abcdef1');
    expect(versionState(null).text).toBe('Versión de desarrollo');
  });
});
