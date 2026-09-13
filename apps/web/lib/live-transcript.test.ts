import { describe, expect, it } from 'vitest';
import {
  type LiveTranscriptLine,
  mergeTranscriptSnapshot,
  upsertDisplayLine,
} from './live-transcript';

const line = (overrides: Partial<LiveTranscriptLine>): LiveTranscriptLine => ({
  text: 'hola',
  isFinal: false,
  speaker: null,
  at: 1,
  ...overrides,
});

describe('live transcript display rows', () => {
  it('updates a growing GPT Live row by its stable id', () => {
    const first = line({
      id: 'assistant-1',
      source: 'gpt-live',
      role: 'assistant',
      text: 'Buenos',
    });
    const grown = line({ ...first, text: 'Buenos días', endMs: 820 });

    expect(upsertDisplayLine([first], grown)).toEqual([grown]);
  });

  it('keeps overlapping GPT Live speakers in separate rows', () => {
    const user = line({ id: 'user-1', source: 'gpt-live', role: 'user', speaker: 'Ana' });
    const assistant = line({ id: 'assistant-1', source: 'gpt-live', role: 'assistant' });

    expect(upsertDisplayLine([user], assistant).map((item) => item.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
  });

  it('retains GPT Live rows from snapshots although they are not final', () => {
    const live = line({ id: 'user-1', source: 'gpt-live', role: 'user' });
    const deepgramInterim = line({ text: 'parcial de Deepgram' });

    expect(mergeTranscriptSnapshot([], [live, deepgramInterim])).toEqual([live]);
  });

  it('preserves existing rows when a polled snapshot is temporarily behind', () => {
    const current = line({
      id: 'assistant-2',
      source: 'gpt-live',
      role: 'assistant',
      text: 'respuesta completa',
      at: 2,
      endMs: 900,
    });
    const stale = line({ ...current, text: 'respuesta', endMs: 600 });

    expect(mergeTranscriptSnapshot([current], [stale])).toEqual([current]);
  });

  it('deduplicates traditional final Deepgram lines', () => {
    const final = line({ isFinal: true, speaker: 'Ana' });

    expect(mergeTranscriptSnapshot([final], [final])).toEqual([final]);
  });
});
