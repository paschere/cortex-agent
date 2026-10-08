import { describe, expect, it } from 'vitest';
import { clampProgressLine, createProgressThrottle, latestProgress } from './tool-progress';

function harness() {
  let t = 1000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  const out: string[] = [];
  const th = createProgressThrottle((l) => out.push(l), {
    intervalMs: 750,
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { fn, at: t + ms, id: timers.length };
      timers.push(e);
      return e;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const e of [...timers])
      if (e.at <= t) {
        timers.splice(timers.indexOf(e), 1);
        e.fn();
      }
  };
  return { th, out, advance };
}

describe('createProgressThrottle', () => {
  it('emite la primera al instante y la última de la ráfaga al cerrar la ventana', () => {
    const { th, out, advance } = harness();
    th.push('uno');
    th.push('dos');
    th.push('tres');
    expect(out).toEqual(['uno']);
    advance(750);
    expect(out).toEqual(['uno', 'tres']);
  });
  it('cancel descarta lo pendiente', () => {
    const { th, out, advance } = harness();
    th.push('uno');
    th.push('dos');
    th.cancel();
    advance(2000);
    expect(out).toEqual(['uno']);
  });
  it('recorta y aplana', () => {
    expect(clampProgressLine('a\n  b')).toBe('a b');
    expect(clampProgressLine('x'.repeat(300)).length).toBe(160);
  });
});

describe('latestProgress', () => {
  it('toma la última por toolCallId e ignora otras anotaciones', () => {
    const m = latestProgress([
      { type: 'tool-progress', toolCallId: 'a', line: 'vieja', at: 1 },
      { type: 'tool-progress', toolCallId: 'a', line: 'nueva', at: 2 },
      { type: 'otra' },
      null,
    ]);
    expect(m.get('a')).toBe('nueva');
    expect(latestProgress(undefined).size).toBe(0);
  });
});
