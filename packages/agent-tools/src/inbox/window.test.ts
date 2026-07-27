import { describe, expect, it } from 'vitest';
import { isWithinWindow, localMinutesOfDay, parseHHMM, startOfLocalDay } from './window';

describe('parseHHMM', () => {
  it('parses valid 24-hour times', () => {
    expect(parseHHMM('07:30')).toBe(450);
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('9:05')).toBe(545);
  });

  it('rejects anything else', () => {
    for (const bad of ['24:00', '07:60', '7.30', 'morning', '', '07:3']) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe('isWithinWindow', () => {
  const W = 30;

  it('fires for a time inside the window that just ended', () => {
    expect(isWithinWindow(450, 450, W)).toBe(true); // exactly on the minute
    expect(isWithinWindow(450, 479, W)).toBe(true); // 29 minutes later
  });

  it('does not fire before the time or after the window', () => {
    expect(isWithinWindow(450, 449, W)).toBe(false); // one minute early
    expect(isWithinWindow(450, 480, W)).toBe(false); // window has passed
  });

  it('wraps around midnight', () => {
    expect(isWithinWindow(1435, 5, W)).toBe(true); // 23:55 target, 00:05 now
    expect(isWithinWindow(5, 1435, W)).toBe(false);
  });

  it('covers every minute exactly once across consecutive runs', () => {
    for (let target = 0; target < 1440; target++) {
      const hits = [0, 30, 60, 90].filter((offset) =>
        isWithinWindow(target, (target + offset) % 1440, W),
      );
      expect(hits).toEqual([0]);
    }
  });
});

describe('localMinutesOfDay', () => {
  it('reads the wall clock in the given zone', () => {
    // 2026-07-14T12:00:00Z — Bogotá is UTC-5 year round.
    const at = new Date('2026-07-14T12:00:00Z');
    expect(localMinutesOfDay('UTC', at)).toBe(12 * 60);
    expect(localMinutesOfDay('America/Bogota', at)).toBe(7 * 60);
  });

  it('returns null for a zone it cannot use', () => {
    expect(localMinutesOfDay('Mars/Olympus', new Date())).toBeNull();
  });
});

describe('startOfLocalDay', () => {
  it('rolls back to local midnight', () => {
    const at = new Date('2026-07-14T12:00:00Z');
    expect(startOfLocalDay('UTC', at).toISOString()).toBe('2026-07-14T00:00:00.000Z');
    // 07:00 local in Bogotá → midnight local is 05:00 UTC.
    expect(startOfLocalDay('America/Bogota', at).toISOString()).toBe('2026-07-14T05:00:00.000Z');
  });
});
