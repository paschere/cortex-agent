import { describe, expect, it } from 'vitest';
import { parseMeetingUrl } from './meeting-url';

describe('parseMeetingUrl (web)', () => {
  it('rejects insecure, credential-bearing and malformed meeting links', () => {
    expect(parseMeetingUrl('http://zoom.us/j/12345678901')).toBeNull();
    expect(parseMeetingUrl('https://user:secret@zoom.us/j/12345678901')).toBeNull();
    expect(parseMeetingUrl('https://teams.microsoft.com/l/%zz')).toBeNull();
  });
  it('accepts Meet, Teams and Zoom', () => {
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij')?.platform).toBe('google_meet');
    expect(
      parseMeetingUrl('https://teams.microsoft.com/l/meetup-join/19:meeting_x/0')?.platform,
    ).toBe('teams');
    expect(parseMeetingUrl('https://zoom.us/j/12345678901')?.code).toBe('12345678901');
  });
});
