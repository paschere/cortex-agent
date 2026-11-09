import { describe, expect, it, vi } from 'vitest';
import {
  AppLive,
  type EventSourceLike,
  LIVE_OFF_AFTER_FAILURES,
  LiveChannel,
  type LiveStatus,
  liveBackoffMs,
} from './code-live';

class FakeSource implements EventSourceLike {
  handlers = new Map<string, (ev: { data?: string }) => void>();
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data?: string }) => void) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    this.handlers.get(type)?.({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const changes: Array<[string, string]> = [];
  const statuses: LiveStatus[] = [];
  const channel = new LiveChannel({
    url: (t) => `/live?tables=${t.join(',')}`,
    makeSource: (u) => {
      const s = new FakeSource(u);
      sources.push(s);
      return s;
    },
    onChange: (t, at) => changes.push([t, at]),
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (id) => {
      (id as { live: boolean }).live = false;
    },
    now: () => 0,
  });
  const fire = () => {
    const t = timers.filter((x) => x.live).pop();
    if (t) {
      t.live = false;
      t.fn();
    }
  };
  return { channel, sources, timers, changes, statuses, fire };
}

describe('espera creciente', () => {
  it('1 s, 2 s, 4 s… con tope de 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(liveBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(liveBackoffMs(0)).toBe(0);
  });
});

describe('LiveChannel', () => {
  it('abre un canal con la unión ordenada y pasa a live al conectar', () => {
    const h = harness();
    h.channel.setTables(['guias', 'vuelos', 'guias']);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.url).toBe('/live?tables=guias,vuelos');
    expect(h.channel.getStatus()).toBe('reconnecting');
    h.sources[0]?.emit('open');
    expect(h.channel.getStatus()).toBe('live');
  });

  it('entrega los cambios y se ignora un aviso mal formado', () => {
    const h = harness();
    h.channel.setTables(['vuelos']);
    h.sources[0]?.emit('open');
    h.sources[0]?.emit('change', { table: 'vuelos', at: 'T' });
    h.sources[0]?.handlers.get('change')?.({ data: '{no json' });
    expect(h.changes).toEqual([['vuelos', 'T']]);
  });

  it('no reabre si la unión es la misma; si cambia, cierra el anterior y abre otro', () => {
    const h = harness();
    h.channel.setTables(['a']);
    h.channel.setTables(['a']);
    expect(h.sources).toHaveLength(1);
    h.channel.setTables(['a', 'b']);
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.sources).toHaveLength(2);
    h.channel.setTables([]);
    expect(h.sources[1]?.closed).toBe(true);
    expect(h.channel.getStatus()).toBe('off');
  });

  it('reconecta con espera creciente, y tras 5 fallos queda off pero sigue intentando', () => {
    const h = harness();
    h.channel.setTables(['a']);
    const waits: number[] = [];
    for (let i = 0; i < LIVE_OFF_AFTER_FAILURES; i++) {
      h.sources[h.sources.length - 1]?.onerror?.({});
      waits.push(h.timers[h.timers.length - 1]?.ms ?? -1);
      if (i < LIVE_OFF_AFTER_FAILURES - 1) {
        expect(h.channel.getStatus()).toBe('reconnecting');
        h.fire();
      }
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 60000]);
    expect(h.channel.getStatus()).toBe('off');
    // Sigue intentando, despacio.
    h.fire();
    expect(h.sources.length).toBe(LIVE_OFF_AFTER_FAILURES + 1);
  });

  it('al reabrir tras un corte da por cambiada cada tabla', () => {
    const h = harness();
    h.channel.setTables(['a', 'b']);
    h.sources[0]?.emit('open');
    expect(h.changes).toEqual([]);
    h.sources[0]?.onerror?.({});
    h.fire();
    h.sources[1]?.emit('open');
    expect(h.channel.getStatus()).toBe('live');
    expect(h.changes.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('el cierre planeado del servidor reabre enseguida y sin contar como fallo', () => {
    const h = harness();
    h.channel.setTables(['a']);
    h.sources[0]?.emit('open');
    h.sources[0]?.emit('closed');
    expect(h.sources).toHaveLength(2);
    expect(h.timers).toHaveLength(0);
  });

  it('close() corta todo y no reintenta', () => {
    const h = harness();
    h.channel.setTables(['a']);
    h.sources[0]?.onerror?.({});
    h.channel.close();
    h.fire();
    expect(h.sources).toHaveLength(1);
    expect(h.channel.getStatus()).toBe('off');
  });
});

describe('AppLive', () => {
  it('une las tablas de los marcos y avisa solo a los interesados', () => {
    const sources: FakeSource[] = [];
    const seen: Array<[string, string[]]> = [];
    const live = new AppLive({
      url: (t) => t.join(','),
      makeSource: (u) => {
        const s = new FakeSource(u);
        sources.push(s);
        return s;
      },
      onChange: (table, _at, interested) => seen.push([table, interested]),
      onStatus: vi.fn(),
    });
    live.setFrameTables('f1', ['vuelos']);
    live.setFrameTables('f2', ['guias', 'vuelos']);
    expect(sources[sources.length - 1]?.url).toBe('guias,vuelos');
    const s = sources[sources.length - 1];
    s?.emit('open');
    s?.emit('change', { table: 'guias', at: 'T' });
    s?.emit('change', { table: 'vuelos', at: 'T' });
    expect(seen).toEqual([
      ['guias', ['f2']],
      ['vuelos', ['f1', 'f2']],
    ]);
    live.removeFrame('f2');
    expect(sources[sources.length - 1]?.url).toBe('vuelos');
    live.localChange('vuelos');
    expect(seen[seen.length - 1]).toEqual(['vuelos', ['f1']]);
    live.removeFrame('f1');
    expect(live.getStatus()).toBe('off');
  });
});
