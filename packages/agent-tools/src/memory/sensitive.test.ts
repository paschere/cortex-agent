import { describe, expect, it } from 'vitest';
import { behaviouralCandidates, usableCandidates } from './derive';
import { screenMemory } from './sensitive';

/**
 * A memory rides along in every prompt, so it lands in every log and every
 * provider request. These tests are about what must never get in — and,
 * equally, about the ordinary preferences that must not be blocked by the same
 * rules, because a screen that refuses "we quote in USD" is one somebody turns
 * off.
 */
describe('screenMemory', () => {
  it('keeps the memories this feature exists for', () => {
    for (const good of [
      'Prefers every cost quoted in USD, monthly.',
      'Never CC the client on internal threads.',
      'When they say "the matcher" they mean tpp.example.com.',
      'Owns the Growth pipeline and reviews it on Mondays.',
      'Responde siempre en español, aunque le escriban en inglés.',
      'Quotes senior React around 8,500 a month before discount.',
    ]) {
      expect(screenMemory(good), good).toMatchObject({ ok: true });
    }
  });

  it('refuses credentials, labelled or not', () => {
    expect(screenMemory('Their API key is stored in the vault.').reason).toBe('credential');
    expect(screenMemory('Use sk-abcd1234efgh5678ijkl9012 for that.').reason).toBe('credential');
    expect(screenMemory('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345').reason).toBe('credential');
  });

  it('refuses a pay figure attached to a pay word', () => {
    expect(screenMemory("María's salary is 4,500 USD a month.").reason).toBe('compensation');
    expect(screenMemory('Su sueldo es de 12.000.000 COP.').reason).toBe('compensation');
  });

  it('refuses contact details and identity numbers', () => {
    expect(screenMemory('Reach their assistant at ana@example.com first.').reason).toBe(
      'contact-detail',
    );
    expect(screenMemory('Their cédula is on file for the contract.').reason).toBe('identifier');
  });

  it('refuses on length rather than truncating', () => {
    expect(screenMemory('hi').reason).toBe('too-short');
    expect(screenMemory('x'.repeat(400)).reason).toBe('too-long');
  });

  it('explains itself — a refusal with no reason is a bug report', () => {
    const refused = screenMemory('The password is hunter2hunter2hunter2');
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/won't keep/i);
  });
});

describe('behaviouralCandidates', () => {
  const at = (day: number, hour: number) =>
    new Date(Date.UTC(2026, 6, day, hour, 0, 0)).toISOString();

  it('says nothing when there is nothing to count', () => {
    expect(behaviouralCandidates([], 'UTC')).toEqual([]);
    expect(
      behaviouralCandidates([{ tool_id: 'kb.search', status: 'ok', created_at: at(1, 12) }], 'UTC'),
    ).toEqual([]);
  });

  it('reports the families someone actually works in, with the count as evidence', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({
        tool_id: 'payroll.team_assignments',
        status: 'ok',
        created_at: at(1, 12 + (i % 4)),
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        tool_id: 'hubspot.search_deals',
        status: 'ok',
        created_at: at(2, 12 + (i % 4)),
      })),
    ];
    const [first] = behaviouralCandidates(rows, 'UTC');
    expect(first?.source).toBe('behavioural');
    expect(first?.content).toMatch(/payroll/);
    expect(first?.note).toMatch(/20×/);
  });

  it('ignores agent turns, which are not tool use', () => {
    const rows = Array.from({ length: 30 }, () => ({
      tool_id: '__agent_turn',
      status: 'ok',
      created_at: at(1, 12),
    }));
    expect(behaviouralCandidates(rows, 'UTC')).toEqual([]);
  });

  it('flags a family that keeps failing, once', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({
        tool_id: 'gmail.search',
        status: i % 2 === 0 ? 'error' : 'ok',
        created_at: at(1, 12),
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        tool_id: 'gcal.list_events',
        status: i % 2 === 0 ? 'error' : 'ok',
        created_at: at(1, 12),
      })),
    ];
    const failures = behaviouralCandidates(rows, 'UTC').filter((c) => c.kind === 'instruction');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.note).toMatch(/failed/);
  });
});

describe('usableCandidates', () => {
  const candidate = (content: string) => ({
    content,
    kind: 'fact' as const,
    source: 'derived' as const,
    note: 'why',
  });

  it('drops what the person already has, in any status', () => {
    const out = usableCandidates(
      [candidate('Prefers costs in USD.'), candidate('Owns the Growth pipeline.')],
      ['prefers costs in usd.'],
      5,
    );
    expect(out.map((c) => c.content)).toEqual(['Owns the Growth pipeline.']);
  });

  it('drops anything the sensitivity screen refuses, even if the model liked it', () => {
    const out = usableCandidates([candidate('Their salary is 5,000 USD.')], [], 5);
    expect(out).toEqual([]);
  });

  it('respects the per-run cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate(`Fact number ${i} about them.`));
    expect(usableCandidates(many, [], 3)).toHaveLength(3);
  });
});
