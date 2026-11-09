import { describe, expect, it } from 'vitest';
import { MAX_LIVE_FRAMES, activate, drop, emptyPool, poolContext } from './frame-pool';

const spec = (screen: string, q = '') => ({
  screen,
  src: `/api/apps/a/code/${screen}/frame${q}`,
});
const ctx = poolContext({ appId: 'a', buildId: 'b1', scope: 'admin:u1' });

describe('iframes vivos: LRU', () => {
  it('conserva las últimas 4 y descarta la menos reciente', () => {
    let s = emptyPool(ctx);
    const evicted: string[] = [];
    for (const sc of ['a', 'b', 'c', 'd', 'e']) {
      const r = activate(s, spec(sc), ctx);
      s = r.state;
      evicted.push(...r.evicted.map((e) => e.screen));
    }
    expect(s.entries.map((e) => e.screen)).toEqual(['b', 'c', 'd', 'e']);
    expect(evicted).toEqual(['a']);
    expect(s.entries.length).toBe(MAX_LIVE_FRAMES);
  });

  it('volver a una pantalla la hace la más reciente y reusa su iframe', () => {
    let s = emptyPool(ctx);
    for (const sc of ['a', 'b', 'c']) s = activate(s, spec(sc), ctx).state;
    const before = s.entries.find((e) => e.screen === 'a');
    const r = activate(s, spec('a'), ctx);
    expect(r.active).toBe(before);
    expect(r.evicted).toEqual([]);
    expect(r.state.entries.map((e) => e.screen)).toEqual(['b', 'c', 'a']);
    // Tras la vuelta, la que se descarta es la menos reciente real.
    let t = r.state;
    t = activate(t, spec('d'), ctx).state;
    const out = activate(t, spec('e'), ctx);
    expect(out.evicted.map((e) => e.screen)).toEqual(['b']);
  });

  it('si cambian los parámetros del marco (prefill) esa pantalla se recarga', () => {
    let s = emptyPool(ctx);
    s = activate(s, spec('a', '?guia=1'), ctx).state;
    const old = s.entries[0];
    const r = activate(s, spec('a', '?guia=2'), ctx);
    expect(r.active.id).not.toBe(old?.id);
    expect(r.evicted).toEqual([old]);
    expect(r.state.entries).toHaveLength(1);
  });

  it('si cambia la compilación o el rol, descarta todo lo vivo', () => {
    let s = emptyPool(ctx);
    for (const sc of ['a', 'b']) s = activate(s, spec(sc), ctx).state;
    const other = poolContext({ appId: 'a', buildId: 'b2', scope: 'admin:u1' });
    const r = activate(s, spec('b'), other);
    expect(r.evicted.map((e) => e.screen).sort()).toEqual(['a', 'b']);
    expect(r.state.entries.map((e) => e.screen)).toEqual(['b']);
    expect(r.state.ctx).toBe(other);
    const viewAs = poolContext({ appId: 'a', buildId: 'b2', scope: 'admin:u1', como: '?como=op' });
    expect(viewAs).not.toBe(other);
    expect(activate(r.state, spec('b'), viewAs).evicted).toHaveLength(1);
  });

  it('los ids no se repiten aunque se recargue la misma pantalla', () => {
    let s = emptyPool(ctx);
    const ids = new Set<string>();
    for (const q of ['?1', '?2', '?3']) {
      const r = activate(s, spec('a', q), ctx);
      s = r.state;
      ids.add(r.active.id);
    }
    expect(ids.size).toBe(3);
  });

  it('con max 1 se comporta como el iframe suelto de antes', () => {
    let s = emptyPool(ctx);
    s = activate(s, spec('a'), ctx, 1).state;
    const r = activate(s, spec('b'), ctx, 1);
    expect(r.state.entries.map((e) => e.screen)).toEqual(['b']);
    expect(r.evicted.map((e) => e.screen)).toEqual(['a']);
  });

  it('drop quita una entrada', () => {
    let s = emptyPool(ctx);
    const r = activate(s, spec('a'), ctx);
    s = drop(r.state, r.active.id);
    expect(s.entries).toEqual([]);
  });
});
