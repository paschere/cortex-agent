import assert from 'node:assert/strict';
import { parseMeetingUrl } from './meeting-url';

assert.equal(parseMeetingUrl('https://meet.google.com/abc-defg-hij')?.platform, 'google_meet');
assert.equal(parseMeetingUrl('https://us02web.zoom.us/j/84335626851?pwd=x')?.code, '84335626851');
assert.equal(
  parseMeetingUrl('https://teams.live.com/meet/123456789')?.platform,
  'teams',
);
assert.equal(parseMeetingUrl('https://example.com/j/1'), null);

console.log('meeting-url.test ok');
