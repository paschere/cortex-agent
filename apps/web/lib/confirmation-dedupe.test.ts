import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  createProposalGuard,
  dedupeProposals,
  pendingTwinIndexes,
  proposalKey,
} from './confirmation-dedupe';

const input = { slug: 'atenciones', name: 'Atenciones', fields: [{ key: 'a', type: 'text' }] };
// Mismo contenido, otro orden de llaves.
const reordered = { fields: [{ type: 'text', key: 'a' }], name: 'Atenciones', slug: 'atenciones' };

describe('dedupeProposals', () => {
  it('quita la gemela con otro toolCallId y la misma entrada, sin importar el orden de llaves', () => {
    const out = dedupeProposals([
      { toolCallId: 'a', toolId: 'trackers.define', input },
      { toolCallId: 'b', toolId: 'trackers.define', input: reordered },
    ]);
    expect(out.map((i) => i.toolCallId)).toEqual(['a']);
  });
  it('quita el mismo toolCallId repetido', () => {
    const out = dedupeProposals([
      { toolCallId: 'a', toolId: 'x.y', input: 1 },
      { toolCallId: 'a', toolId: 'x.y', input: 2 },
    ]);
    expect(out).toHaveLength(1);
  });
  it('conserva las distintas: otra herramienta u otra entrada', () => {
    const out = dedupeProposals([
      { toolCallId: 'a', toolId: 'trackers.define', input },
      { toolCallId: 'b', toolId: 'trackers.define', input: { ...input, name: 'Otra' } },
      { toolCallId: 'c', toolId: 'views.create', input },
    ]);
    expect(out).toHaveLength(3);
  });
});

describe('createProposalGuard', () => {
  it('la segunda propuesta idéntica del turno se marca repetida', () => {
    const g = createProposalGuard();
    expect(g.seen('trackers.define', input)).toBe(false);
    expect(g.seen('trackers.define', reordered)).toBe(true);
    expect(g.seen('trackers.define', { ...input, name: 'Otra' })).toBe(false);
    expect(g.seen('views.create', input)).toBe(false);
  });
  it('lo que lee el modelo es corto y dice que no lo repita', () => {
    const r = createProposalGuard().duplicate('trackers.define');
    expect(r.message).toBe(DUPLICATE_PROPOSAL_MESSAGE);
    expect(r.message).toContain('no lo repitas');
    expect(r.__duplicate_proposal).toBe(true);
  });
});

describe('pendingTwinIndexes', () => {
  const sentinel = (toolCallId: string, inp: unknown, toolId = 'trackers.define') => ({
    toolCallId,
    result: { __requires_confirmation: true, toolId, input: inp },
  });
  it('al aprobar una, encuentra a su gemela pendiente y no a las demás', () => {
    const results = [
      sentinel('a', input),
      { toolCallId: 'z', result: { ok: true } },
      sentinel('b', reordered),
      sentinel('c', { ...input, name: 'Otra' }),
      sentinel('d', input, 'views.create'),
    ];
    expect(pendingTwinIndexes(results, 0)).toEqual([2]);
  });
  it('sin gemelas, nada', () => {
    expect(pendingTwinIndexes([sentinel('a', input)], 0)).toEqual([]);
    expect(proposalKey('a', 1)).not.toBe(proposalKey('b', 1));
  });
});
