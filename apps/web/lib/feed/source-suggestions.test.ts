import { describe, expect, it } from 'vitest';
import { type FeedSourceMetadata, suggestFromFeedMetadata } from './source-suggestions';

const source = (sourceId: string, sourceName: string, headers: string[]): FeedSourceMetadata => ({
  sourceId,
  sourceName,
  sourceKind: 'file',
  attachmentId: `${sourceId}-attachment`,
  attachmentName: `${sourceName}.csv`,
  truncated: false,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sheets: [{ index: 0, name: 'Hoja 1', rowCount: 4, headers }],
});

describe('Feed source suggestions', () => {
  it('preserves header positions and only proposes a candidate for an identical stable header', () => {
    const result = suggestFromFeedMetadata([
      source('11111111-1111-4111-8111-111111111111', 'Personas', ['', 'id', 'Nombre']),
      source('22222222-2222-4222-8222-222222222222', 'Estados', ['id', 'Estado']),
      source('33333333-3333-4333-8333-333333333333', 'Tareas', ['Tarea', 'Fecha límite', 'Estado']),
    ]);
    const combined = result.proposals.find((proposal) => proposal.type === 'combined');
    expect(combined?.mappings?.[0]?.left.column).toBe(1);
    expect(combined?.reason).toContain('candidato editable');
    const task = result.proposals.find((proposal) => proposal.title.includes('tareas vencidas'));
    expect(task?.definition).not.toHaveProperty('identityColumns');
  });

  it('does not treat similar names as an identity or invent an activation', () => {
    const result = suggestFromFeedMetadata([
      source('44444444-4444-4444-8444-444444444444', 'A', ['Nombre']),
      source('55555555-5555-4555-8555-555555555555', 'B', ['Nombre completo']),
    ]);
    expect(result.proposals.some((proposal) => proposal.type === 'combined')).toBe(false);

    const caseVariant = suggestFromFeedMetadata([
      source('66666666-6666-4666-8666-666666666666', 'C', ['id']),
      source('77777777-7777-4777-8777-777777777777', 'D', ['ID']),
    ]);
    expect(caseVariant.proposals.some((proposal) => proposal.type === 'combined')).toBe(false);

    const repeatedHeader = suggestFromFeedMetadata([
      source('88888888-8888-4888-8888-888888888888', 'E', ['id', 'id']),
      source('99999999-9999-4999-8999-999999999999', 'F', ['id']),
    ]);
    expect(repeatedHeader.proposals.some((proposal) => proposal.type === 'combined')).toBe(false);
  });
});
