import { describe, expect, it } from 'vitest';
import { approvedResultsBlock, compactResult } from './approved-results';

describe('approvedResultsBlock', () => {
  it('cuenta lo ejecutado y omite lo que sigue esperando', () => {
    const block = approvedResultsBlock([
      {
        toolName: 'trackers.define',
        result: { tracker: { slug: 'vuelos', name: 'Vuelos', id: 't1' }, fields: [1, 2, 3] },
      },
      { toolName: 'apps.create', result: { __requires_confirmation: true } },
      { toolName: 'views.create', result: { __confirmation_in_progress: true } },
    ]);
    expect(block).toContain('trackers.define');
    expect(block).toContain('"slug":"vuelos"');
    expect(block).not.toContain('apps.create');
    expect(block).not.toContain('views.create');
  });
  it('vacío si no hay nada ejecutado', () => {
    expect(
      approvedResultsBlock([{ toolName: 'x', result: { __requires_confirmation: true } }]),
    ).toBe('');
    expect(approvedResultsBlock(null)).toBe('');
  });
  it('un error se dice como error', () => {
    expect(compactResult({ __error: true, message: 'Sin permiso' })).toBe('falló: Sin permiso');
  });
  it('no se pasa del tope', () => {
    expect(compactResult({ message: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(600);
  });
});
