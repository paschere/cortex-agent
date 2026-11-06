import { describe, expect, it, vi } from 'vitest';
import {
  FRESH_MS,
  INVALIDATING_OPS,
  READ_OPS,
  ReadCache,
  type SdkResult,
  TTL_MS,
  serveRead,
} from './code-read-cache';

function harness(now = { t: 1_000_000 }) {
  const cache = new ReadCache(() => now.t);
  const replies: SdkResult[] = [];
  const updates: unknown[] = [];
  const run = (
    p: {
      scope?: string;
      args?: unknown;
      wantsUpdate?: boolean;
      app?: string;
      op?: string;
    },
    fetchFresh: () => Promise<SdkResult>,
  ) =>
    serveRead({
      cache,
      appId: p.app ?? 'planta',
      scope: p.scope ?? 'admin:u1|',
      op: p.op ?? 'tables.query',
      args: p.args ?? { table: 'vuelos' },
      wantsUpdate: p.wantsUpdate ?? true,
      fetchFresh,
      reply: (r) => replies.push(r),
      update: (d) => updates.push(d),
    });
  return { cache, now, replies, updates, run };
}
const ok = (data: unknown): SdkResult => ({ ok: true, data });

describe('caché de lecturas del padre', () => {
  it('la primera vez va a la red; la segunda responde al instante con lo guardado y manda el dato nuevo si cambió', async () => {
    const h = harness();
    await h.run({}, async () => ok({ n: 1 }));
    expect(h.replies).toEqual([ok({ n: 1 })]);
    h.now.t += FRESH_MS + 10;
    const fetchFresh = vi.fn(async () => ok({ n: 2 }));
    await h.run({}, fetchFresh);
    expect(h.replies[1]).toEqual(ok({ n: 1 })); // lo guardado, primero
    expect(fetchFresh).toHaveBeenCalledOnce();
    expect(h.updates).toEqual([{ n: 2 }]);
  });

  it('sin cambios no manda update; lo recién traído no se vuelve a pedir', async () => {
    const h = harness();
    await h.run({}, async () => ok(1));
    const f = vi.fn(async () => ok(1));
    await h.run({}, f); // < FRESH_MS
    expect(f).not.toHaveBeenCalled();
    h.now.t += FRESH_MS + 1;
    await h.run({}, f);
    expect(f).toHaveBeenCalledOnce();
    expect(h.updates).toEqual([]);
  });

  it('lo viejo (>= 60 s) no se sirve', async () => {
    const h = harness();
    await h.run({}, async () => ok('a'));
    h.now.t += TTL_MS + 1;
    const f = vi.fn(async () => ok('b'));
    await h.run({}, f);
    expect(h.replies[1]).toEqual(ok('b'));
    expect(h.updates).toEqual([]);
  });

  it('un SDK viejo (sin upd) siempre va a la red', async () => {
    const h = harness();
    await h.run({ wantsUpdate: false }, async () => ok('a'));
    const f = vi.fn(async () => ok('b'));
    await h.run({ wantsUpdate: false }, f);
    expect(f).toHaveBeenCalledOnce();
    expect(h.replies[1]).toEqual(ok('b'));
  });

  it('una escritura vacía todo lo de esa app (y no las otras)', async () => {
    const h = harness();
    await h.run({}, async () => ok('a'));
    await h.run({ app: 'otra' }, async () => ok('o'));
    h.cache.invalidate('planta');
    h.now.t += FRESH_MS + 1;
    const f = vi.fn(async () => ok('nuevo'));
    await h.run({}, f);
    expect(h.replies[2]).toEqual(ok('nuevo')); // no hubo hit
    const g = vi.fn(async () => ok('x'));
    await h.run({ app: 'otra' }, g);
    expect(h.replies[3]).toEqual(ok('o'));
  });

  it('una lectura que salió antes de la escritura no guarda su respuesta vieja', async () => {
    const h = harness();
    let release: (r: SdkResult) => void = () => undefined;
    const slow = h.run(
      {},
      () =>
        new Promise<SdkResult>((r) => {
          release = r;
        }),
    );
    h.cache.invalidate('planta'); // la escritura termina mientras la lectura vuela
    release(ok('viejo'));
    await slow;
    expect(
      h.cache.get('planta', ReadCache.key('admin:u1|', 'tables.query', { table: 'vuelos' })),
    ).toBeNull();
  });

  it('la clave incluye rol/«ver como», operación y argumentos', async () => {
    const h = harness();
    await h.run({ scope: 'admin:u1|' }, async () => ok('admin'));
    h.now.t += FRESH_MS + 1;
    const f = vi.fn(async () => ok('operario'));
    await h.run({ scope: 'operario:u2|?como=operario' }, f);
    expect(f).toHaveBeenCalledOnce();
    expect(h.replies[1]).toEqual(ok('operario')); // no vio lo del admin
    const g = vi.fn(async () => ok('otros args'));
    await h.run({ args: { table: 'vuelos', limit: 5 } }, g);
    expect(h.replies[2]).toEqual(ok('otros args'));
  });

  it('los errores no se guardan', async () => {
    const h = harness();
    await h.run({}, async () => ({ ok: false, error: 'no' }));
    const f = vi.fn(async () => ok('b'));
    await h.run({}, f);
    expect(f).toHaveBeenCalledOnce();
    expect(h.replies[1]).toEqual(ok('b'));
  });

  it('qué lee y qué invalida', () => {
    for (const op of [
      'tables.query',
      'tables.get',
      'tables.list',
      'user.me',
      'geofences.list',
      'tables.listActions',
    ])
      expect(READ_OPS.has(op)).toBe(true);
    for (const op of [
      'tables.insert',
      'tables.update',
      'tables.action',
      'files.upload',
      'functions.call',
    ])
      expect(INVALIDATING_OPS.has(op)).toBe(true);
    expect(READ_OPS.has('tables.insert')).toBe(false);
  });
});
