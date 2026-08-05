import { describe, expect, it } from 'vitest';
import { assessFreshness, describeAge, isSuperseded } from './freshness';

const NOW = new Date('2026-08-04T00:00:00Z');

describe('describeAge', () => {
  it('is deliberately coarse', () => {
    expect(describeAge(0)).toBe('de hoy');
    expect(describeAge(1)).toBe('de ayer');
    expect(describeAge(12)).toBe('de hace 12 días');
    expect(describeAge(150)).toBe('de hace 5 meses');
    expect(describeAge(400)).toBe('de hace un año');
    expect(describeAge(800)).toBe('de hace 2 años');
  });
});

describe('assessFreshness', () => {
  it('carries the age of a recent document without editorialising', () => {
    const f = assessFreshness({ datedAt: '2026-07-18T00:00:00Z', now: NOW });
    expect(f.status).toBe('current');
    expect(f.label).toBe('de hace 17 días');
  });

  it('marks a document old enough to be worth double-checking', () => {
    expect(assessFreshness({ datedAt: '2025-12-01T00:00:00Z', now: NOW }).status).toBe('aging');
    expect(assessFreshness({ datedAt: '2024-01-01T00:00:00Z', now: NOW }).status).toBe('old');
  });

  it('says an expired policy expired, and when', () => {
    const f = assessFreshness({
      datedAt: '2025-02-01T00:00:00Z',
      validUntil: '2026-01-31T00:00:00Z',
      now: NOW,
    });
    expect(f.status).toBe('expired');
    expect(f.label).toBe('venció el 31 de enero de 2026');
  });

  it('does not call a policy expired before its date passes', () => {
    const f = assessFreshness({
      datedAt: '2026-06-01T00:00:00Z',
      validUntil: '2027-01-31T00:00:00Z',
      now: NOW,
    });
    expect(f.status).toBe('current');
  });

  it('points at the replacement, which is the useful half of the answer', () => {
    const f = assessFreshness({
      datedAt: '2026-03-05T00:00:00Z',
      supersededByTitle: 'Tarifas Acme — agosto 2026',
      now: NOW,
    });
    expect(f.status).toBe('superseded');
    expect(f.label).toContain('reemplazado por «Tarifas Acme — agosto 2026»');
  });

  it('lets a replacement outrank an expiry, because it says where to look next', () => {
    const f = assessFreshness({
      datedAt: '2025-02-01T00:00:00Z',
      validUntil: '2026-01-31T00:00:00Z',
      supersededByTitle: 'Póliza 2026',
      now: NOW,
    });
    expect(f.status).toBe('superseded');
  });

  it('treats a document with no date as current rather than inventing an age', () => {
    const f = assessFreshness({ datedAt: null, now: NOW });
    expect(f.status).toBe('current');
    expect(f.ageDays).toBeNull();
    expect(f.label).toBe('');
  });

  it('knows which two statuses must never be quoted in the present tense', () => {
    expect(isSuperseded('expired')).toBe(true);
    expect(isSuperseded('superseded')).toBe(true);
    expect(isSuperseded('old')).toBe(false);
  });
});
