import { describe, expect, it } from 'vitest';
import { classifyBulk, parseAddress, parseAddressList, summarizeExclusions } from './filters';
import { rowToPreferences } from './preferences';

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('"Ada Lovelace" <ada@example.com>')).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
  });

  it('handles a bare address', () => {
    expect(parseAddress('ADA@Example.com')).toEqual({ name: null, email: 'ada@example.com' });
  });

  it('returns null for something that is not an address', () => {
    expect(parseAddress('undisclosed recipients')).toBeNull();
  });

  it('splits a list without breaking on commas inside quoted names', () => {
    const list = parseAddressList('"Lovelace, Ada" <ada@x.com>, bob@y.com');
    expect(list.map((a) => a.email)).toEqual(['ada@x.com', 'bob@y.com']);
    expect(list[0]?.name).toBe('Lovelace, Ada');
  });
});

describe('classifyBulk', () => {
  const human = { name: 'Ana', email: 'ana@client.com' };

  it('keeps ordinary correspondence', () => {
    expect(classifyBulk({ headers: [], labelIds: ['INBOX'], from: human }).bulk).toBe(false);
  });

  it('drops anything with an unsubscribe header, and says why', () => {
    const v = classifyBulk({
      headers: [{ name: 'List-Unsubscribe', value: '<mailto:x@y.com>' }],
      labelIds: [],
      from: human,
    });
    expect(v.bulk).toBe(true);
    expect(v.reason).toMatch(/unsubscribe/i);
  });

  it('drops Gmail promotions', () => {
    const v = classifyBulk({ headers: [], labelIds: ['CATEGORY_PROMOTIONS'], from: human });
    expect(v.bulk).toBe(true);
    expect(v.reason).toContain('promotions');
  });

  it('drops unattended sender addresses', () => {
    expect(
      classifyBulk({ headers: [], labelIds: [], from: { name: null, email: 'no-reply@app.com' } })
        .bulk,
    ).toBe(true);
    expect(
      classifyBulk({
        headers: [],
        labelIds: [],
        from: { name: null, email: 'notifications@app.com' },
      }).bulk,
    ).toBe(true);
  });

  it('does NOT drop real shared inboxes a client might write from', () => {
    for (const email of ['info@client.com', 'support@client.com', 'hello@client.com']) {
      expect(classifyBulk({ headers: [], labelIds: [], from: { name: null, email } }).bulk).toBe(
        false,
      );
    }
  });

  it('drops bulk-mail-provider domains', () => {
    const v = classifyBulk({
      headers: [],
      labelIds: [],
      from: { name: null, email: 'campaign@mail.mailchimp.com' },
    });
    expect(v.bulk).toBe(true);
  });

  it('honours Precedence: bulk and Auto-Submitted', () => {
    expect(
      classifyBulk({ headers: [{ name: 'Precedence', value: 'bulk' }], labelIds: [], from: human })
        .bulk,
    ).toBe(true);
    expect(
      classifyBulk({
        headers: [{ name: 'Auto-Submitted', value: 'auto-generated' }],
        labelIds: [],
        from: human,
      }).bulk,
    ).toBe(true);
    expect(
      classifyBulk({
        headers: [{ name: 'Auto-Submitted', value: 'no' }],
        labelIds: [],
        from: human,
      }).bulk,
    ).toBe(false);
  });
});

describe('summarizeExclusions', () => {
  it('says nothing was filtered when nothing was', () => {
    expect(summarizeExclusions([])).toBe('Nothing was filtered out.');
  });

  it('groups reasons with counts so the filtering can be checked', () => {
    const note = summarizeExclusions(['it is a newsletter', 'it is a newsletter', 'it is spam']);
    expect(note).toContain('3 conversations left out');
    expect(note).toContain('2 because it is a newsletter');
    expect(note).toContain('1 because it is spam');
  });
});

describe('rowToPreferences', () => {
  it('treats a missing row as fully opted out', () => {
    const p = rowToPreferences('u1', null);
    expect(p.enabled).toBe(false);
    expect(p.deliverChat).toBe(false);
    expect(p.chatWebhookUrl).toBeNull();
  });

  it('reads an opted-in row', () => {
    const p = rowToPreferences('u1', {
      inbox_digest_enabled: true,
      inbox_digest_time: '08:15',
      timezone: 'America/Mexico_City',
      deliver_email: false,
      deliver_chat: true,
      chat_webhook_url: 'https://chat.googleapis.com/v1/spaces/X/messages?key=a&token=b',
      digest_focus: '  clients first  ',
    });
    expect(p).toMatchObject({
      enabled: true,
      time: '08:15',
      timezone: 'America/Mexico_City',
      deliverEmail: false,
      deliverChat: true,
      digestFocus: 'clients first',
    });
  });

  it('never reads a truthy-ish value as an opt-in', () => {
    expect(rowToPreferences('u1', { inbox_digest_enabled: 'true' }).enabled).toBe(false);
    expect(rowToPreferences('u1', { inbox_digest_enabled: 1 }).enabled).toBe(false);
  });
});
