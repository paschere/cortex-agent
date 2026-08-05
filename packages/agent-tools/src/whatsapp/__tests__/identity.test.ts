import { beforeEach, describe, expect, it } from 'vitest';
import {
  UNKNOWN_SENDER_REPLY,
  isGroupJid,
  normalizePhone,
  recordUnknownSender,
  resolveWhatsappSender,
} from '../identity';
import { type Row, makeDb } from './fake-db';

/**
 * What these tests protect: that a turn never runs for a number nobody linked.
 *
 * Cortex's tools read payroll, write to HubSpot and answer out of Brain
 * Knowledge. A phone number is not an identity claim — it is a string anybody
 * can put in a contact card — so "unknown number" has to be a hard stop, not a
 * degraded mode. These tests are what make that binding.
 */

const USER = '00000000-0000-0000-0000-000000000001';
const ORG = 'org-acme';

let store: Record<string, Row[]>;

beforeEach(() => {
  store = {
    whatsapp_links: [
      {
        phone_e164: '573001112233',
        user_id: USER,
        organization_id: ORG,
        display_name: 'Ana Ruiz',
      },
    ],
    security_events: [],
  };
});

describe('normalizePhone', () => {
  it('reduces a WhatsApp JID to the digits the link table is keyed on', () => {
    expect(normalizePhone('573001112233@s.whatsapp.net')).toBe('573001112233');
    // Multi-device puts the device id after a colon.
    expect(normalizePhone('573001112233:14@s.whatsapp.net')).toBe('573001112233');
  });

  it('accepts a number a person typed, however they punctuated it', () => {
    expect(normalizePhone('+57 300 111 2233')).toBe('573001112233');
    expect(normalizePhone('(57) 300-111-2233')).toBe('573001112233');
  });

  it('refuses anything that cannot be a phone number', () => {
    // A best guess here would be a lookup key that matches the wrong person.
    expect(normalizePhone('1234')).toBeNull();
    expect(normalizePhone('status@broadcast')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('9'.repeat(16))).toBeNull();
  });
});

describe('isGroupJid', () => {
  it('tells a group apart from a person', () => {
    expect(isGroupJid('120363000000000001@g.us')).toBe(true);
    expect(isGroupJid('573001112233@s.whatsapp.net')).toBe(false);
  });
});

describe('resolveWhatsappSender', () => {
  it('resolves a linked number to a person and their workspace', async () => {
    const sender = await resolveWhatsappSender(makeDb(store), '573001112233@s.whatsapp.net');

    expect(sender).toEqual({
      phone: '573001112233',
      userId: USER,
      organizationId: ORG,
      displayName: 'Ana Ruiz',
    });
  });

  it('refuses a number nobody linked', async () => {
    expect(await resolveWhatsappSender(makeDb(store), '573009998877@s.whatsapp.net')).toBeNull();
  });

  it('refuses a number that is not a number', async () => {
    expect(await resolveWhatsappSender(makeDb(store), 'status@broadcast')).toBeNull();
  });

  it('does not fall back to matching a person by any other field', async () => {
    // Deliberately absent behaviour: no lookup against a self-service phone
    // field on the user record, because that would turn "type your colleague's
    // number into your profile" into privilege escalation.
    store.users = [{ id: USER, phone: '573009998877', organization_id: ORG }];
    expect(await resolveWhatsappSender(makeDb(store), '573009998877')).toBeNull();
  });
});

describe('the refusal', () => {
  it('says enough for a colleague and nothing for a stranger', () => {
    expect(UNKNOWN_SENDER_REPLY).toContain('administrador');
    // No company name, no capability list, no hint that another number works.
    expect(UNKNOWN_SENDER_REPLY.length).toBeLessThan(240);
  });

  it('records the attempt without filing the whole message', async () => {
    await recordUnknownSender(makeDb(store), {
      phone: '573009998877',
      preview: 'x'.repeat(500),
    });

    const event = (store.security_events ?? [])[0] as Row;
    expect(event.tool_id).toBe('whatsapp.inbound');
    expect(event.decision).toBe('block');
    const signals = event.signals as { phone: string; preview: string };
    expect(signals.phone).toBe('573009998877');
    // Evidence that somebody wrote, not a copy of what they wrote.
    expect(signals.preview.length).toBe(120);
  });
});
