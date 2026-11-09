import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBridge } from './bridge';
import { cortex } from './cortex';
import { getOutbox, isHostVisible, onHostVisible } from './events';

/** Una «ventana» mínima: el host (parent) y el oyente de mensajes del iframe. */
function setup() {
  const sent: Array<{ cortex: number; id: string; op: string; args: unknown }> = [];
  const parent = { postMessage: vi.fn((m: (typeof sent)[number]) => sent.push(m)) };
  let handler: ((e: unknown) => void) | null = null;
  vi.stubGlobal('window', {
    parent,
    addEventListener: (_t: string, h: (e: unknown) => void) => {
      handler = h;
    },
    removeEventListener: () => {
      handler = null;
    },
  });
  const push = (data: unknown) => handler?.({ source: parent, data });
  return { sent, push };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetBridge();
  vi.unstubAllGlobals();
});

describe('cortex.live', () => {
  it('pide al host la unión de tablas y entrega solo los cambios de cada suscripción', async () => {
    const { sent, push } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const offA = cortex.live.subscribe(['vuelos'], a);
    cortex.live.subscribe(['guias', 'vuelos'], b);
    await tick();
    // Dos suscripciones seguidas = una sola llamada con la unión.
    const sets = sent.filter((m) => m.op === 'live.set');
    expect(sets).toHaveLength(1);
    expect(sets[0]?.args).toEqual({ tables: ['guias', 'vuelos'] });
    push({ cortex: 1, id: sets[0]?.id, ok: true, data: { status: 'live' } });
    await tick();
    expect(cortex.live.status()).toBe('live');

    push({ cortex: 1, event: 'changed', table: 'guias', at: 't1' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ table: 'guias', at: 't1' });
    push({ cortex: 1, event: 'changed', table: 'vuelos', at: 't2' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    offA();
    push({ cortex: 1, event: 'changed', table: 'vuelos', at: 't3' });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('refleja el estado del canal que manda el host', () => {
    const { push } = setup();
    cortex.live.subscribe(['x'], () => undefined);
    push({ cortex: 1, event: 'live-status', status: 'reconnecting' });
    expect(cortex.live.status()).toBe('reconnecting');
    push({ cortex: 1, event: 'live-status', status: 'raro' });
    expect(cortex.live.status()).toBe('reconnecting');
  });

  it('un host sin canal en vivo deja el estado en off', async () => {
    const { sent, push } = setup();
    cortex.live.subscribe(['x'], () => undefined);
    await tick();
    push({ cortex: 1, id: sent[0]?.id, ok: false, error: 'No existe' });
    await tick();
    expect(cortex.live.status()).toBe('off');
  });
});

describe('visibilidad y cola', () => {
  it('el host oculta y muestra la pantalla', () => {
    const { push } = setup();
    cortex.live.subscribe(['x'], () => undefined);
    const seen: boolean[] = [];
    onHostVisible((v) => seen.push(v));
    push({ cortex: 1, event: 'visible', visible: false });
    expect(isHostVisible()).toBe(false);
    push({ cortex: 1, event: 'visible', visible: true });
    expect(seen).toEqual([false, true]);
  });

  it('guarda el estado de la cola que manda el host', () => {
    const { push } = setup();
    cortex.live.subscribe(['x'], () => undefined);
    push({
      cortex: 1,
      event: 'outbox',
      state: { items: [], pending: 2, failed: 1, online: false },
    });
    expect(getOutbox()).toMatchObject({ pending: 2, failed: 1, online: false });
  });
});

describe('escrituras offline', () => {
  it('manda offline: true solo cuando se pide', async () => {
    const { sent } = setup();
    void cortex.tables.insert('vuelos', { a: 1 }).catch(() => undefined);
    void cortex.tables.insert('vuelos', { a: 1 }, { offline: true }).catch(() => undefined);
    void cortex.tables.update('vuelos', 'r1', { a: 2 }, { offline: true }).catch(() => undefined);
    void cortex.tables
      .action('vuelos', 'r1', 'cerrar', { reason: 'x', offline: true })
      .catch(() => undefined);
    expect(sent[0]?.args).toEqual({ table: 'vuelos', values: { a: 1 } });
    expect(sent[1]?.args).toMatchObject({ offline: true });
    expect(sent[2]?.args).toMatchObject({ id: 'r1', offline: true });
    expect(sent[3]?.args).toMatchObject({ action: 'cerrar', reason: 'x', offline: true });
  });
});
