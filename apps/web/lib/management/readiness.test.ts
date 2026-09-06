import { describe, expect, it } from 'vitest';
import { managementReadiness } from './readiness';
const empty = {
  configured: false,
  owner: false,
  manuals: 0,
  goals: 0,
  sources: false,
  knowledge: false,
  verified: 0,
};
describe('company readiness uses evidence rather than visited screens', () => {
  it('does not mistake missing source reads for incomplete or complete configuration', () => {
    const result = managementReadiness({
      ...empty,
      configured: null,
      owner: null,
      manuals: null,
      goals: null,
      verified: null,
    });
    expect(result.filter((s) => s.state === 'unknown').map((s) => s.id)).toEqual([
      'scope',
      'owner',
      'goals',
      'process',
      'proof',
    ]);
  });
  it('does not require an integration when permanent knowledge is available', () => {
    const result = managementReadiness({ ...empty, knowledge: true });
    expect(result.find((s) => s.id === 'context')?.state).toBe('ready');
    expect(result.find((s) => s.id === 'proof')?.state).toBe('pending');
  });
  it('requires actual saved configuration and a verified case', () => {
    expect(managementReadiness(empty).every((s) => s.state === 'pending')).toBe(true);
    expect(
      managementReadiness({ ...empty, configured: true, verified: 1 })
        .filter((s) => s.state === 'ready')
        .map((s) => s.id),
    ).toEqual(['scope', 'proof']);
  });
});
