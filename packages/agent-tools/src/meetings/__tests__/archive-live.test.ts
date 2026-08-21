import { describe, expect, it } from 'vitest';
import { linesToTurns, liveConferenceRecord } from '../archive-live';

describe('linesToTurns', () => {
  it('drops empty lines and labels a missing speaker', () => {
    const turns = linesToTurns([
      { text: '  ', speaker: 'Ana', at: 1 },
      { text: 'Hola', speaker: null, at: 2.4 },
    ]);
    expect(turns).toEqual([{ speaker: 'Alguien', startMs: 2400, endMs: 2400, text: 'Hola' }]);
  });

  it('merges consecutive lines from the same person', () => {
    const turns = linesToTurns([
      { text: 'El presupuesto', speaker: 'Mateo', at: 10 },
      { text: 'queda en 40', speaker: 'Mateo', at: 12 },
      { text: 'De acuerdo', speaker: 'Ana', at: 15 },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      speaker: 'Mateo',
      startMs: 10_000,
      text: 'El presupuesto queda en 40',
    });
    expect(turns[1]?.speaker).toBe('Ana');
    expect(turns[0]?.endMs).toBe(15_000);
  });
});

describe('liveConferenceRecord', () => {
  it('is a Meet-shaped sitting id the ledger can key on', () => {
    expect(liveConferenceRecord('m_abc_1')).toBe('liveSessions/m_abc_1');
  });
});
