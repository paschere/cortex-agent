import { ValidationError } from '@zipdev/core';
import { describe, expect, it } from 'vitest';
import { flattenMarkdownForChat, isGoogleChatWebhookUrl, parseChatWebhookUrl } from './webhook';

const VALID =
  'https://chat.googleapis.com/v1/spaces/AAQA1b2c3d4/messages?key=SECRETKEY&token=SECRETTOKEN';

describe('parseChatWebhookUrl', () => {
  it('accepts a real Google Chat webhook and extracts the space', () => {
    const target = parseChatWebhookUrl(VALID);
    expect(target.space).toBe('spaces/AAQA1b2c3d4');
    expect(target.url).toContain('chat.googleapis.com');
  });

  it.each([
    ['a different host', 'https://evil.example.com/v1/spaces/X/messages?key=a&token=b'],
    [
      'a look-alike subdomain',
      'https://chat.googleapis.com.evil.io/v1/spaces/X/messages?key=a&token=b',
    ],
    ['plain http', 'http://chat.googleapis.com/v1/spaces/X/messages?key=a&token=b'],
    ['loopback', 'https://127.0.0.1/v1/spaces/X/messages?key=a&token=b'],
    ['cloud metadata', 'https://169.254.169.254/v1/spaces/X/messages?key=a&token=b'],
    [
      'credentials in the URL',
      'https://u:p@chat.googleapis.com/v1/spaces/X/messages?key=a&token=b',
    ],
    ['the wrong path', 'https://chat.googleapis.com/v1/spaces/X/threads?key=a&token=b'],
    ['a missing token', 'https://chat.googleapis.com/v1/spaces/X/messages?key=a'],
    ['nonsense', 'not-a-url'],
    ['empty', '   '],
  ])('rejects %s', (_label, url) => {
    expect(() => parseChatWebhookUrl(url)).toThrow(ValidationError);
    expect(isGoogleChatWebhookUrl(url)).toBe(false);
  });
});

describe('flattenMarkdownForChat', () => {
  it('turns headings into bold lines', () => {
    expect(flattenMarkdownForChat('# Your digest')).toBe('*Your digest*');
    expect(flattenMarkdownForChat('### Needs you')).toBe('*Needs you*');
  });

  it('converts double asterisks to the single-asterisk Chat form', () => {
    expect(flattenMarkdownForChat('**Ana** replied')).toBe('*Ana* replied');
  });

  it('renders bullets with a bullet glyph', () => {
    expect(flattenMarkdownForChat('- one\n- two')).toBe('• one\n• two');
  });

  it('rewrites links into the <url|label> form', () => {
    expect(flattenMarkdownForChat('[open](https://mail.google.com/x)')).toBe(
      '<https://mail.google.com/x|open>',
    );
  });

  it('flattens a table into one bullet per row with header labels', () => {
    const md = [
      '| Subject | From | Waiting |',
      '| --- | --- | --- |',
      '| Invoice | Ana | 2d |',
    ].join('\n');
    expect(flattenMarkdownForChat(md)).toBe('• *Invoice* — From: Ana · Waiting: 2d');
  });

  it('drops horizontal rules and collapses blank runs', () => {
    expect(flattenMarkdownForChat('a\n\n\n---\n\n\nb')).toBe('a\n\nb');
  });

  it('truncates to the Chat message limit', () => {
    const out = flattenMarkdownForChat('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('…')).toBe(true);
  });
});
