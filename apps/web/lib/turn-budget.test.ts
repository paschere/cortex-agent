import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_DURATION_S,
  createTurnBudget,
  hardMarginMs,
  runWithinBudget,
  turnLimitMs,
} from './turn-budget';

/** Un reloj y unos timers a mano: el tiempo avanza cuando la prueba lo dice. */
function fakeClock(start = 0) {
  let t = start;
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const h = { at: t + ms, fn, done: false };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown) => {
      (h as { done: boolean }).done = true;
    },
    advance(ms: number) {
      t += ms;
      for (const h of timers)
        if (!h.done && h.at <= t) {
          h.done = true;
          h.fn();
        }
    },
  };
}

describe('presupuesto del turno', () => {
  it('sobre 800 s: deja de empezar herramientas a los 560 s y corta limpio a los 740 s', () => {
    const c = fakeClock();
    const b = createTurnBudget({ limitMs: 800_000, startedAt: 0, ...c });
    expect(b.softAt).toBe(560_000);
    expect(b.hardAt).toBe(740_000);
    c.advance(559_999);
    expect(b.pastSoft()).toBe(false);
    c.advance(1);
    expect(b.pastSoft()).toBe(true);
    expect(b.signal.aborted).toBe(false);
    c.advance(180_000);
    expect(b.signal.aborted).toBe(true);
    expect(b.reason()).toBe('deadline');
  });

  it('si el cliente se va, aborta con su razón', () => {
    const c = fakeClock();
    const parent = new AbortController();
    const b = createTurnBudget({ limitMs: 800_000, startedAt: 0, parent: parent.signal, ...c });
    parent.abort();
    expect(b.signal.aborted).toBe(true);
    expect(b.reason()).toBe('client');
  });

  it('la variable de entorno acorta, nunca alarga, y nunca baja de un minuto', () => {
    expect(turnLimitMs({})).toBe(CHAT_MAX_DURATION_S * 1000);
    expect(turnLimitMs({ CHAT_TURN_BUDGET_SECONDS: '300' })).toBe(300_000);
    expect(turnLimitMs({ CHAT_TURN_BUDGET_SECONDS: '5000' })).toBe(800_000);
    expect(turnLimitMs({ CHAT_TURN_BUDGET_SECONDS: '10' })).toBe(60_000);
    expect(turnLimitMs({ CHAT_TURN_BUDGET_SECONDS: 'abc' })).toBe(800_000);
    expect(hardMarginMs(800_000)).toBe(60_000);
    expect(hardMarginMs(60_000)).toBe(20_000);
  });
});

describe('herramientas dentro del presupuesto', () => {
  it('pasado el umbral blando, la herramienta NO corre y el modelo lee «sin tiempo»', async () => {
    let ran = false;
    const out = await runWithinBudget(
      { pastSoft: () => true, msUntilHard: () => 100_000 },
      'trackers.list',
      undefined,
      async () => {
        ran = true;
        return 'ok';
      },
    );
    expect(ran).toBe(false);
    expect(out).toMatchObject({ __error: true, out_of_time: true });
    expect(JSON.stringify(out)).toContain('sigue');
  });

  it('sin margen para empezar tampoco corre', async () => {
    const out = await runWithinBudget(
      { pastSoft: () => false, msUntilHard: () => 5_000 },
      't',
      undefined,
      async () => 'ok',
    );
    expect(out).toMatchObject({ out_of_time: true });
  });

  it('una herramienta que se pasa de su tope se deja de esperar y su señal se aborta', async () => {
    let signal: AbortSignal | undefined;
    const out = await runWithinBudget(
      { pastSoft: () => false, msUntilHard: () => 100_000 },
      'lenta',
      undefined,
      (s) => {
        signal = s;
        return new Promise(() => {});
      },
      { toolMaxMs: 20 },
    );
    expect(out).toMatchObject({ __error: true, timed_out: true, tool: 'lenta' });
    expect(signal?.aborted).toBe(true);
  });

  it('dentro del tiempo devuelve el resultado tal cual', async () => {
    const out = await runWithinBudget(
      { pastSoft: () => false, msUntilHard: () => 100_000 },
      't',
      undefined,
      async () => ({ rows: 3 }),
    );
    expect(out).toEqual({ rows: 3 });
  });
});
