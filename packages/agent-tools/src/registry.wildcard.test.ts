import { describe, expect, it } from 'vitest';
import { filterTools, isToolAvailable, listTools } from './index';

/**
 * The '*' grant exists so that a new integration is usable the moment it is
 * registered. These tests are the reason it can be trusted: they fail if it
 * ever stops covering everything, or starts covering the test fixtures.
 */
describe("the '*' tool grant", () => {
  it('covers every registered tool except the test fixtures', () => {
    const all = listTools().filter((t) => !t.id.startsWith('test.') && isToolAvailable(t));
    const granted = filterTools(['*']);
    expect(granted).toHaveLength(all.length);
    expect(granted.map((t) => t.id).sort()).toEqual(all.map((t) => t.id).sort());
  });

  it('never grants the test fixtures', () => {
    expect(filterTools(['*']).some((t) => t.id.startsWith('test.'))).toBe(false);
  });

  it('leaves family and exact patterns behaving as before', () => {
    const family = filterTools(['kb.*']);
    expect(family.length).toBeGreaterThan(0);
    expect(family.every((t) => t.id.startsWith('kb.'))).toBe(true);
    expect(filterTools(['kb.search']).map((t) => t.id)).toEqual(['kb.search']);
  });
});

describe('tools that depend on an unconfigured service', () => {
  it('payroll.* tools that need PAYROLL_API_URL are not offered without it', () => {
    const prev = process.env.PAYROLL_API_URL;
    try {
      process.env.PAYROLL_API_URL = '';
      const off = filterTools(['payroll.*']).map((t) => t.id);
      expect(off).not.toContain('payroll.payroll_stats');
      expect(off).not.toContain('payroll.team_overview');
      expect(off).toContain('payroll.period_summary');
      process.env.PAYROLL_API_URL = 'https://payroll.internal';
      expect(filterTools(['payroll.*']).map((t) => t.id)).toContain('payroll.payroll_stats');
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'PAYROLL_API_URL');
      else process.env.PAYROLL_API_URL = prev;
    }
  });
});
