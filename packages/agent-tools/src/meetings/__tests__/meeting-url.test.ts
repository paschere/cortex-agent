import { describe, expect, it } from 'vitest';
import { isMeetingUrl, meetingPlatformLabel, parseMeetingUrl } from '../meeting-url';

describe('parseMeetingUrl', () => {
  it('reads a Google Meet code', () => {
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toEqual({
      platform: 'google_meet',
      href: 'https://meet.google.com/abc-defg-hij?authuser=0',
      code: 'abc-defg-hij',
    });
  });

  it('reads a Zoom id and passcode', () => {
    const parsed = parseMeetingUrl('https://us02web.zoom.us/j/84335626851?pwd=secret');
    expect(parsed?.platform).toBe('zoom');
    expect(parsed?.code).toBe('84335626851');
    expect(parsed?.passcode).toBe('secret');
  });

  it('reads a Teams meetup-join link', () => {
    const parsed = parseMeetingUrl(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcXYZ123/0?context=%7b%7d',
    );
    expect(parsed?.platform).toBe('teams');
    expect(parsed?.code).toBe('abcXYZ123');
  });

  it('rejects a random https url', () => {
    expect(parseMeetingUrl('https://example.com/meet')).toBeNull();
    expect(isMeetingUrl('https://example.com/meet')).toBe(false);
  });

  it('labels platforms for the archive title', () => {
    expect(meetingPlatformLabel('google_meet')).toBe('Meet');
    expect(meetingPlatformLabel('teams')).toBe('Teams');
    expect(meetingPlatformLabel('zoom')).toBe('Zoom');
  });
});
