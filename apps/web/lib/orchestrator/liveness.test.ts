import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  QUIET_AFTER_MS,
  STALE_AFTER_MS,
  isQuiet,
  isStale,
  silenceMs,
  staleCutoffIso,
} from './liveness';
import type { RunStatus } from './types';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(status: RunStatus, heartbeatAgo: number | null) {
  return {
    status,
    lastHeartbeatAt: heartbeatAgo === null ? null : ago(heartbeatAgo),
    startedAt: null,
    createdAt: ago(60 * 60_000),
  };
}

describe('the thresholds themselves', () => {
  it('leaves room for the screen to hedge before the sweep acts', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(QUIET_AFTER_MS);
    expect(QUIET_AFTER_MS).toBeLessThan(STALE_AFTER_MS);
    // The sweep must never be able to close a run between two ordinary beats.
    expect(STALE_AFTER_MS / HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(10);
  });
});

describe('silenceMs', () => {
  it('measures from the last sign of life', () => {
    expect(silenceMs(run('running', 90_000), NOW)).toBe(90_000);
  });

  it('has no answer for a run that already ended', () => {
    expect(silenceMs(run('completed', 4 * 60 * 60_000), NOW)).toBeNull();
    expect(silenceMs(run('interrupted', 4 * 60 * 60_000), NOW)).toBeNull();
  });

  it('falls back to creation for a row written before migration 0070', () => {
    expect(silenceMs(run('running', null), NOW)).toBe(60 * 60_000);
  });
});

describe('the two verdicts', () => {
  it('says nothing about a run that beat a moment ago', () => {
    const fresh = run('running', HEARTBEAT_INTERVAL_MS);
    expect(isQuiet(fresh, NOW)).toBe(false);
    expect(isStale(fresh, NOW)).toBe(false);
  });

  it('hedges on screen well before it declares anything dead', () => {
    const quiet = run('running', QUIET_AFTER_MS + 1_000);
    expect(isQuiet(quiet, NOW)).toBe(true);
    expect(isStale(quiet, NOW)).toBe(false);
  });

  it('declares a long silence dead', () => {
    const dead = run('running', STALE_AFTER_MS + 1_000);
    expect(isQuiet(dead, NOW)).toBe(true);
    expect(isStale(dead, NOW)).toBe(true);
  });

  it('judges a run still planning by the same clock', () => {
    expect(isStale(run('planning', STALE_AFTER_MS + 1_000), NOW)).toBe(true);
  });

  it('never judges a finished run', () => {
    expect(isStale(run('completed', 10 * 60 * 60_000), NOW)).toBe(false);
    expect(isQuiet(run('cancelled', 10 * 60 * 60_000), NOW)).toBe(false);
  });
});

describe('staleCutoffIso', () => {
  it('is exactly the threshold behind the given instant', () => {
    expect(staleCutoffIso(NOW)).toBe(new Date(NOW - STALE_AFTER_MS).toISOString());
  });
});
