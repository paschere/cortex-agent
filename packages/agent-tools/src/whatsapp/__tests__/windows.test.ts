import { describe, expect, it } from 'vitest';
import {
  type StagedMessage,
  displayName,
  planWindows,
  renderMessageText,
  windowKeyOf,
} from '../windows';

/**
 * What these tests protect.
 *
 * The grouping rule is the whole design (see the header of `windows.ts`). If it
 * is wrong, everything downstream is still correct and still useless: documents
 * that are too small to mean anything or too big to retrieve. Nothing about it
 * needs a WhatsApp account to check, so all of it is checked here.
 */

// Bogotá is UTC-5 all year, so a local midnight is 05:00Z. Every fixture below
// is written in UTC and the local day is the interesting part.
const ZONE = 'America/Bogota';

let seq = 0;
function msg(sentAt: string, from: string, text: string): StagedMessage {
  seq += 1;
  return {
    id: `row-${seq}`,
    messageId: `wa-${seq}`,
    senderJid: `57300111${String(seq).padStart(4, '0')}@s.whatsapp.net`,
    senderName: from,
    sentAt,
    body: text,
    kind: 'text',
    transcript: null,
    mediaFilename: null,
    attachmentDocumentId: null,
  };
}

const NOW = Date.parse('2026-03-03T23:00:00Z');

describe('planWindows', () => {
  it('keeps a burst of conversation in one window', () => {
    const { closed } = planWindows(
      [
        msg('2026-03-03T14:00:00Z', 'Ana', 'sale el camión a las 3'),
        msg('2026-03-03T14:02:00Z', 'Beto', 'confirmo con la bodega'),
        msg('2026-03-03T14:11:00Z', 'Ana', 'listo, ya cargaron'),
      ],
      { nowMs: NOW, timeZone: ZONE },
    );

    expect(closed).toHaveLength(1);
    expect(closed[0]?.messages).toHaveLength(3);
    expect(closed[0]?.participants).toEqual(['Ana', 'Beto']);
  });

  it('splits when the group goes quiet past the idle gap', () => {
    const { closed } = planWindows(
      [
        msg('2026-03-03T09:00:00Z', 'Ana', 'buenos días'),
        msg('2026-03-03T09:05:00Z', 'Beto', 'buenos días'),
        // Three hours later: a different episode, not a continuation.
        msg('2026-03-03T12:10:00Z', 'Ana', 'el cliente llamó por la guía'),
        msg('2026-03-03T12:12:00Z', 'Beto', 'la mando ya'),
      ],
      { nowMs: NOW, timeZone: ZONE, idleGapMinutes: 45 },
    );

    expect(closed).toHaveLength(2);
    expect(closed[0]?.messages.map((m) => m.body)).toEqual(['buenos días', 'buenos días']);
    expect(closed[1]?.messages.map((m) => m.body)).toEqual([
      'el cliente llamó por la guía',
      'la mando ya',
    ]);
  });

  it('never lets a window cross local midnight', () => {
    const { closed } = planWindows(
      [
        // 23:50 in Bogotá on the 3rd.
        msg('2026-03-04T04:50:00Z', 'Ana', 'seguimos con el inventario'),
        // 00:05 in Bogotá on the 4th — twenty minutes later, but a new day.
        msg('2026-03-04T05:05:00Z', 'Beto', 'quedan 4 estibas'),
      ],
      { nowMs: Date.parse('2026-03-04T09:00:00Z'), timeZone: ZONE, idleGapMinutes: 45 },
    );

    expect(closed).toHaveLength(2);
  });

  it('closes a window that has run past the ceiling even without a pause', () => {
    // A message every twenty minutes for eleven hours: never idle, never a new
    // day, and exactly the feed-shaped group the ceiling exists for.
    const messages: StagedMessage[] = [];
    for (let i = 0; i < 33; i++) {
      const at = new Date(Date.parse('2026-03-03T11:00:00Z') + i * 20 * 60_000);
      messages.push(msg(at.toISOString(), 'Sensor', `lectura ${i}`));
    }

    const { closed } = planWindows(messages, {
      nowMs: Date.parse('2026-03-04T09:00:00Z'),
      timeZone: ZONE,
      maxWindowHours: 8,
    });

    expect(closed.length).toBeGreaterThan(1);
    for (const w of closed) {
      expect(w.endMs - w.startMs).toBeLessThan(8 * 3_600_000 + 60_000);
    }
  });

  it('leaves a conversation that is still going alone', () => {
    const now = Date.parse('2026-03-03T14:15:00Z');
    const { closed, open } = planWindows(
      [
        msg('2026-03-03T14:00:00Z', 'Ana', 'el cliente está en línea'),
        msg('2026-03-03T14:10:00Z', 'Beto', 'dame dos minutos'),
      ],
      { nowMs: now, timeZone: ZONE, idleGapMinutes: 45 },
    );

    // Writing this now would mean rewriting — and re-embedding — the same
    // document every few minutes until the conversation ends.
    expect(closed).toHaveLength(0);
    expect(open?.messages).toHaveLength(2);
  });

  it('sorts messages that arrive out of order', () => {
    // Baileys replays history out of order after a reconnect.
    const { closed } = planWindows(
      [
        msg('2026-03-03T14:11:00Z', 'Ana', 'tercero'),
        msg('2026-03-03T14:00:00Z', 'Ana', 'primero'),
        msg('2026-03-03T14:05:00Z', 'Beto', 'segundo'),
      ],
      { nowMs: NOW, timeZone: ZONE },
    );

    expect(closed[0]?.messages.map((m) => m.body)).toEqual(['primero', 'segundo', 'tercero']);
  });

  it('gives the same window the same key however often it is planned', () => {
    const messages = [
      msg('2026-03-03T14:00:00Z', 'Ana', 'a'),
      msg('2026-03-03T14:05:00Z', 'Beto', 'b'),
    ];
    const first = planWindows(messages, { nowMs: NOW, timeZone: ZONE });
    const again = planWindows([...messages].reverse(), { nowMs: NOW, timeZone: ZONE });

    expect(first.closed[0]?.key).toBe(again.closed[0]?.key);
    expect(first.closed[0]?.key).toBe(windowKeyOf(Date.parse('2026-03-03T14:00:00Z')));
  });

  it('has nothing to say about an empty group', () => {
    expect(planWindows([], { nowMs: NOW })).toEqual({ closed: [], open: null });
  });
});

describe('displayName', () => {
  it('uses the push name the group already sees', () => {
    expect(displayName({ senderName: 'Ana Ruiz', senderJid: '573001112233@s.whatsapp.net' })).toBe(
      'Ana Ruiz',
    );
  });

  it('masks the number when WhatsApp gave no name', () => {
    // A group is full of clients and suppliers who never agreed to be in a
    // searchable company archive; their full number is contact information.
    const shown = displayName({ senderName: null, senderJid: '573001112233@s.whatsapp.net' });
    expect(shown).toBe('+57 ···2233');
    expect(shown).not.toContain('573001112233');
  });
});

describe('renderMessageText', () => {
  const base: StagedMessage = {
    id: 'r',
    messageId: 'm',
    senderJid: null,
    senderName: 'Ana',
    sentAt: '2026-03-03T14:00:00Z',
    body: null,
    kind: 'text',
    transcript: null,
    mediaFilename: null,
    attachmentDocumentId: null,
  };

  it('marks a transcribed voice note so it is not mistaken for typing', () => {
    expect(renderMessageText({ ...base, kind: 'voice', transcript: 'ya salió el camión' })).toBe(
      '🎤 ya salió el camión',
    );
  });

  it('keeps an untranscribed voice note as a placeholder rather than dropping it', () => {
    // Dropping it would misrepresent the conversation: a question would look
    // unanswered when in fact somebody answered out loud.
    expect(renderMessageText({ ...base, kind: 'voice' })).toBe('[voice note — not transcribed]');
  });

  it('indexes an image by its caption', () => {
    expect(renderMessageText({ ...base, kind: 'image', body: 'guía del despacho de Acme' })).toBe(
      '[image] guía del despacho de Acme',
    );
  });

  it('says when a shared file became a document of its own', () => {
    expect(
      renderMessageText({
        ...base,
        kind: 'document',
        mediaFilename: 'factura-0921.pdf',
        attachmentDocumentId: 'doc-1',
      }),
    ).toContain('saved to Brain Knowledge');
  });
});
