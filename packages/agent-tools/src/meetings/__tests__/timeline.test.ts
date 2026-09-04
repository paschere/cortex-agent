import { describe, expect, it } from 'vitest';
import {
  clockAt,
  formatTimelineForPrompt,
  looksLikePresenting,
  normalizeTimeline,
  presentingFrames,
  rosterDiff,
  shouldTakeFrame,
} from '../timeline';

describe('looksLikePresenting', () => {
  it('detects Meet English and Spanish chrome', () => {
    expect(looksLikePresenting('Mateo Angel (presenting)')).toBe(true);
    expect(looksLikePresenting('Ana (presentando)')).toBe(true);
    expect(looksLikePresenting('Juan Restrepo')).toBe(false);
  });
});

describe('clockAt', () => {
  it('formats seconds into the call', () => {
    expect(clockAt(0)).toBe('0:00');
    expect(clockAt(75)).toBe('1:15');
  });
});

describe('rosterDiff', () => {
  it('emits joined, left and presenting changes', () => {
    const events = rosterDiff(
      [
        { id: 'a', name: 'Ana' },
        { id: 'm', name: 'Mateo', presenting: true },
      ],
      [
        { id: 'a', name: 'Ana' },
        { id: 'j', name: 'Juan', presenting: true },
      ],
      42,
    );
    expect(events.map((e) => e.kind).sort()).toEqual(['joined', 'left', 'presenting', 'presenting-end']);
    expect(events.find((e) => e.kind === 'left')?.speaker).toBe('Mateo');
    expect(events.find((e) => e.kind === 'joined')?.speaker).toBe('Juan');
    expect(events.find((e) => e.kind === 'presenting')?.speaker).toBe('Juan');
  });

  it('ignores the bot tile', () => {
    expect(
      rosterDiff([{ id: 'bot', name: 'Cortex', self: true }], [{ id: 'bot', name: 'Cortex', self: true }], 1),
    ).toEqual([]);
  });
});

describe('shouldTakeFrame', () => {
  it('always fires when presenting changes', () => {
    expect(
      shouldTakeFrame({
        presentingChanged: true,
        presenting: false,
        secondsSinceFrame: 1,
        framesTaken: 0,
      }),
    ).toBe(true);
  });

  it('samples faster while someone is sharing', () => {
    expect(
      shouldTakeFrame({
        presentingChanged: false,
        presenting: true,
        secondsSinceFrame: 20,
        framesTaken: 1,
      }),
    ).toBe(true);
    expect(
      shouldTakeFrame({
        presentingChanged: false,
        presenting: false,
        secondsSinceFrame: 20,
        framesTaken: 1,
      }),
    ).toBe(false);
  });

  it('stops at the ceiling', () => {
    expect(
      shouldTakeFrame({
        presentingChanged: true,
        presenting: true,
        secondsSinceFrame: 99,
        framesTaken: 80,
      }),
    ).toBe(false);
  });
});

describe('normalizeTimeline', () => {
  it('drops junk and caps the list', () => {
    expect(normalizeTimeline([{ at: -3, kind: 'frame', label: 'sala' }])).toEqual([
      { at: 0, kind: 'frame', label: 'sala', speaker: null, path: null, caption: null },
    ]);
    expect(normalizeTimeline([{ kind: 'nope' }])).toEqual([]);
  });
});

describe('presentingFrames / prompt', () => {
  it('prefers presenting-start frames and writes a readable log', () => {
    const events = normalizeTimeline([
      { at: 10, kind: 'presenting', label: 'Ana comparte', speaker: 'Ana', path: 'a.jpg' },
      { at: 12, kind: 'frame', label: 'sala', path: 'b.jpg' },
    ]);
    expect(presentingFrames(events).map((e) => e.path)).toEqual(['a.jpg']);
    expect(formatTimelineForPrompt(events)).toContain('[0:10] presenting · Ana');
  });
});
