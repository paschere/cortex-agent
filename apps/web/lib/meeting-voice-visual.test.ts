import { describe, expect, it } from 'vitest';
import { MAX_MEETING_VOICE_VISUAL_BYTES, validateMeetingVoiceVisual } from './meeting-voice-visual';

const NOW = 1_800_000_000_000;
const jpeg = (middle = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), middle, Buffer.from([0xff, 0xd9])]).toString(
    'base64',
  );

const valid = {
  imageBase64: jpeg(),
  capturedAt: NOW,
  scope: 'meeting-viewport',
};

describe('validateMeetingVoiceVisual', () => {
  it('accepts a fresh JPEG captured from the meeting viewport', () => {
    expect(validateMeetingVoiceVisual(valid, NOW)).toEqual({ ok: true, value: valid });
  });

  it.each([
    null,
    { ...valid, scope: 'https://example.com/private.jpg' },
    { ...valid, path: '/tmp/private.jpg' },
    { ...valid, imageBase64: 'data:image/jpeg;base64,/9j/2Q==' },
    { ...valid, imageBase64: Buffer.from('not jpeg').toString('base64') },
  ])('rejects malformed or externally-addressable visual input %#', (input) => {
    expect(validateMeetingVoiceVisual(input, NOW).ok).toBe(false);
  });

  it('rejects a capture older than 30 seconds', () => {
    expect(validateMeetingVoiceVisual({ ...valid, capturedAt: NOW - 30_001 }, NOW)).toEqual({
      ok: false,
      error: 'visual is stale',
    });
  });

  it('rejects a timestamp more than 5 seconds in the future', () => {
    expect(validateMeetingVoiceVisual({ ...valid, capturedAt: NOW + 5_001 }, NOW)).toEqual({
      ok: false,
      error: 'visual timestamp is in the future',
    });
  });

  it('rejects decoded images larger than 1.5 MiB', () => {
    const oversized = jpeg(Buffer.alloc(MAX_MEETING_VOICE_VISUAL_BYTES));
    expect(validateMeetingVoiceVisual({ ...valid, imageBase64: oversized }, NOW).ok).toBe(false);
  });
});
