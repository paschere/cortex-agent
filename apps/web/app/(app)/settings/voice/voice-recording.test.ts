import { describe, expect, it } from 'vitest';
import {
  MAX_RECORDING_BYTES,
  recordingDurationError,
  recordingSizeError,
  stopStaleStream,
} from './voice-recording';

describe('voice recording validation', () => {
  it('requires five seconds only for the voice sample', () => {
    expect(recordingDurationError('sample', 4.9)).toContain('al menos 5');
    expect(recordingDurationError('sample', 5)).toBeNull();
    expect(recordingDurationError('consent', 3)).toBeNull();
  });

  it('rejects recordings above 30 seconds and files above 2 MiB', () => {
    expect(recordingDurationError('sample', 30)).toBeNull();
    expect(recordingDurationError('sample', 31)).toContain('30 segundos');
    expect(recordingSizeError(MAX_RECORDING_BYTES)).toBeNull();
    expect(recordingSizeError(MAX_RECORDING_BYTES + 1)).toContain('2 MB');
  });

  it('stops a microphone stream that resolves after the recorder became stale', () => {
    let stops = 0;
    const stream = {
      getTracks: () => [
        {
          stop: () => {
            stops += 1;
          },
        },
      ],
    };
    expect(stopStaleStream(stream as Pick<MediaStream, 'getTracks'>, false, false)).toBe(true);
    expect(stops).toBe(1);
    expect(stopStaleStream(stream as Pick<MediaStream, 'getTracks'>, true, true)).toBe(false);
    expect(stops).toBe(1);
  });
});
