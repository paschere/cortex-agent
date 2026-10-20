import { describe, expect, it } from 'vitest';
import { connectionLabel, nextConnection, pollBackoffMs, probeDelayMs } from './connection-state';

describe('nextConnection', () => {
  it('sin red del navegador es sin conexión', () => {
    expect(nextConnection('online', { type: 'browser', online: false })).toBe('offline');
  });
  it('al volver la red no se canta victoria: se reconecta', () => {
    expect(nextConnection('offline', { type: 'browser', online: true })).toBe('reconnecting');
    expect(nextConnection('online', { type: 'browser', online: true })).toBe('online');
  });
  it('sólo cuando el servidor contesta se está en línea', () => {
    expect(nextConnection('reconnecting', { type: 'probe', ok: true })).toBe('online');
    expect(nextConnection('reconnecting', { type: 'probe', ok: false })).toBe('offline');
    expect(nextConnection('online', { type: 'probe', ok: false })).toBe('reconnecting');
  });
  it('un fallo de red con señal pasa a reconectando, y sin señal sigue sin conexión', () => {
    expect(nextConnection('online', { type: 'network-failure' })).toBe('reconnecting');
    expect(nextConnection('offline', { type: 'network-failure' })).toBe('offline');
  });
});

describe('connectionLabel', () => {
  it('en línea y sin nada pendiente casi no se nota', () => {
    const l = connectionLabel('online', 0);
    expect(l.text).toBe('En línea');
    expect(l.prominent).toBe(false);
  });
  it('sin conexión cuenta lo pendiente', () => {
    expect(connectionLabel('offline', 3).text).toBe('Sin conexión · 3 registros por enviar');
    expect(connectionLabel('offline', 1).text).toBe('Sin conexión · 1 registro por enviar');
    expect(connectionLabel('offline', 0).tone).toBe('warn');
  });
  it('reconectando y enviando', () => {
    expect(connectionLabel('reconnecting', 0).text).toBe('Reconectando…');
    expect(connectionLabel('online', 2, true).text).toBe('Enviando 2 registros…');
    expect(connectionLabel('online', 2).text).toBe('2 registros por enviar');
  });
});

describe('probeDelayMs', () => {
  it('crece y tiene tope', () => {
    expect(probeDelayMs(0)).toBe(4000);
    expect(probeDelayMs(1)).toBe(8000);
    expect(probeDelayMs(10)).toBe(60000);
  });
});

describe('pollBackoffMs', () => {
  it('el primer fallo no espacia; los siguientes sí, con tope', () => {
    expect(pollBackoffMs(0)).toBe(0);
    expect(pollBackoffMs(1)).toBe(0);
    expect(pollBackoffMs(2)).toBe(10_000);
    expect(pollBackoffMs(3)).toBe(20_000);
    expect(pollBackoffMs(20)).toBe(120_000);
  });
});
