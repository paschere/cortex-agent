import { describe, expect, it } from 'vitest';
import { filterTools, listTools } from './index';

/**
 * The '*' grant exists so that a new integration is usable the moment it is
 * registered. These tests are the reason it can be trusted: they fail if it
 * ever stops covering everything, or starts covering the test fixtures.
 */
describe("the '*' tool grant", () => {
  it('covers every registered tool except the test fixtures', () => {
    const all = listTools().filter((t) => !t.id.startsWith('test.'));
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
