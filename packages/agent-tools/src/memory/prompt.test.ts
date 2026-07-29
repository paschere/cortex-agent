import { describe, expect, it } from 'vitest';
import { findMemoryEcho, renderMemoryBlock } from './prompt';
import type { MemoryContextEntry } from './types';

function mem(id: string, content: string, kind: MemoryContextEntry['kind'] = 'fact') {
  return { id, content, kind, source: 'explicit' as const, lastUsedAt: null };
}

describe('renderMemoryBlock', () => {
  it('is empty when there is nothing to say', () => {
    expect(renderMemoryBlock([])).toBe('');
  });

  it('adds the do-not-repeat rule only in a group space', () => {
    const memories = [mem('1', 'Prefers costs in USD.')];
    expect(renderMemoryBlock(memories, 'private')).not.toMatch(/room with other people/i);
    expect(renderMemoryBlock(memories, 'group')).toMatch(/room with other people/i);
  });

  it('still carries the memories into a group space — they shape behaviour there too', () => {
    const block = renderMemoryBlock([mem('1', 'Prefers costs in USD.')], 'group');
    expect(block).toContain('Prefers costs in USD.');
  });
});

describe('findMemoryEcho — the group-space guard', () => {
  const memories = [
    mem('m1', 'Never CC the client on internal threads.', 'instruction'),
    mem('m2', 'Prefers every cost quoted in USD.', 'preference'),
    mem('m3', 'Is quietly looking for another job at the moment.'),
  ];

  it('catches an answer that repeats a memory verbatim', () => {
    expect(findMemoryEcho('Sure — never CC the client on internal threads.', memories)).toBe('m1');
  });

  it('catches a lightly reworded restatement', () => {
    // Different grammar, same content words in the same order — which is what
    // a model does when told not to quote something.
    expect(
      findMemoryEcho("I won't CC the client on those internal threads, as you asked.", memories),
    ).toBe('m1');
  });

  it('catches the one that would actually hurt in a room', () => {
    expect(
      findMemoryEcho('Worth noting he is quietly looking for another job right now.', memories),
    ).toBe('m3');
  });

  it('is not diacritic- or case-sensitive', () => {
    const spanish = [mem('s1', 'Nunca copiar al cliente en los hilos internós.', 'instruction')];
    expect(findMemoryEcho('LISTO, NUNCA COPIAR AL CLIENTE EN LOS HILOS INTERNOS.', spanish)).toBe(
      's1',
    );
  });

  it('needs most of the memory, not a couple of its words', () => {
    const memory = [mem('long', 'Owns the Growth pipeline and reviews it with Marta on Mondays.')];
    // Two words in common with a nine-word note is a coincidence, not a leak.
    expect(findMemoryEcho('The Growth pipeline has 12 open signals.', memory)).toBeNull();
  });

  it('lets an answer merely SHAPED by a memory through', () => {
    // The rate is in USD because of m2. Nothing about the memory is disclosed,
    // and withholding this would make the bot useless in a room for no gain.
    expect(findMemoryEcho('That role runs about 8,500 USD a month.', memories)).toBeNull();
    expect(findMemoryEcho('Acme is at stage 3 with two open roles.', memories)).toBeNull();
  });

  it('does not fire on incidental overlap', () => {
    expect(findMemoryEcho('The client asked about internal timelines.', memories)).toBeNull();
  });

  it('is silent when there is nothing to compare', () => {
    expect(findMemoryEcho('', memories)).toBeNull();
    expect(findMemoryEcho('Anything at all here.', [])).toBeNull();
  });
});
