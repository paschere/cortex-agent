import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TIMEOUT_MS, call, resetBridge, withUpdates } from './bridge';
import { cortex } from './cortex';

/** Una «ventana» mínima: el host (parent) y el oyente de mensajes del iframe. */
function setup() {
  const sent: Array<{ cortex: number; id: string; op: string; args: unknown }> = [];
  const parent = { postMessage: vi.fn((m: (typeof sent)[number]) => sent.push(m)) };
  let handler: ((e: unknown) => void) | null = null;
  const win = {
    parent,
    addEventListener: (_t: string, h: (e: unknown) => void) => {
      handler = h;
    },
    removeEventListener: () => {
      handler = null;
    },
  };
  vi.stubGlobal('window', win);
  const reply = (data: unknown, source: unknown = parent) => handler?.({ source, data });
  return { sent, parent, reply };
}

describe('puente', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetBridge();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('envía la operación al host y resuelve con la respuesta', async () => {
    const { sent, reply } = setup();
    const p = cortex.tables.query('vuelos', { limit: 5 });
    expect(sent[0]).toMatchObject({
      cortex: 1,
      op: 'tables.query',
      args: { table: 'vuelos', limit: 5 },
    });
    reply({ cortex: 1, id: sent[0]?.id, ok: true, data: { rows: [] } });
    await expect(p).resolves.toEqual({ rows: [] });
  });

  it('rechaza con el mensaje de error del host', async () => {
    const { sent, reply } = setup();
    const p = call('user.me');
    reply({ cortex: 1, id: sent[0]?.id, ok: false, error: 'No tienes permiso.' });
    await expect(p).rejects.toThrow('No tienes permiso.');
  });

  it('ignora mensajes que no vienen del host o sin la marca', async () => {
    const { sent, reply } = setup();
    const p = call('user.me');
    const id = sent[0]?.id;
    reply({ cortex: 1, id, ok: true, data: 'malo' }, { otra: true });
    reply({ id, ok: true, data: 'sin marca' });
    reply({ cortex: 1, id, ok: true, data: 'bueno' });
    await expect(p).resolves.toBe('bueno');
  });

  it('se rinde a los 30 s con un mensaje en español', async () => {
    setup();
    const p = call('ai.ask', { prompt: 'hola' });
    const assertion = expect(p).rejects.toThrow('tardó demasiado');
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS + 1);
    await assertion;
  });

  it('cada llamada lleva un id distinto', () => {
    const { sent } = setup();
    void call('a').catch(() => undefined);
    void call('b').catch(() => undefined);
    expect(sent[0]?.id).not.toBe(sent[1]?.id);
  });

  it('nav.go y ui.toast usan el mismo canal', () => {
    const { sent } = setup();
    void cortex.nav.go({ screen: 'vuelos', prefill: { a: 1 } }).catch(() => undefined);
    void cortex.ui.toast('Listo').catch(() => undefined);
    expect(sent.map((m) => m.op)).toEqual(['nav.go', 'ui.toast']);
    expect(sent[1]?.args).toEqual({ text: 'Listo' });
  });

  it('sin withUpdates el mensaje no pide segunda respuesta', () => {
    const { sent } = setup();
    void call('user.me').catch(() => undefined);
    expect(sent[0]).not.toHaveProperty('upd');
  });

  it('cortex:update llega a quien lo pidió, una sola vez, y call() ya resolvió con la primera', async () => {
    const { sent, reply } = setup();
    const onUpdate = vi.fn();
    const p = withUpdates(onUpdate, () => call('tables.query', { table: 'a' }));
    expect(sent[0]).toMatchObject({ upd: true });
    const id = sent[0]?.id;
    reply({ cortex: 1, id, ok: true, data: 'guardado' });
    await expect(p).resolves.toBe('guardado');
    expect(onUpdate).not.toHaveBeenCalled();
    reply({ cortex: 1, id, update: true, data: 'fresco' });
    reply({ cortex: 1, id, update: true, data: 'otra' });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('un update sin oyente o de otra ventana se ignora y no rompe la llamada', async () => {
    const { sent, reply } = setup();
    const onUpdate = vi.fn();
    const p = withUpdates(onUpdate, () => call('x'));
    const id = sent[0]?.id;
    reply({ cortex: 1, id, ok: true, data: 1 });
    await p;
    reply({ cortex: 1, id, update: true }, { otra: true });
    expect(onUpdate).not.toHaveBeenCalled();
    const q = call('y');
    reply({ cortex: 1, id: sent[1]?.id, update: true, data: 'x' });
    reply({ cortex: 1, id: sent[1]?.id, ok: true, data: 'ok' });
    await expect(q).resolves.toBe('ok');
  });

  it('withUpdates no deja el oyente puesto después de correr', () => {
    const { sent } = setup();
    withUpdates(vi.fn(), () => undefined);
    void call('z').catch(() => undefined);
    expect(sent[0]).not.toHaveProperty('upd');
  });
});
