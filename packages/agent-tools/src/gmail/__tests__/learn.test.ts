import { describe, expect, it } from 'vitest';
import type { ArchivedThread } from '../learn';
import { extractText, stripQuotedReply } from '../mime';
import { planReplyProposals } from '../propose-replies';
import { backfillQuery, gmailDate, normalizeMessage, threadParticipants } from '../threads';

/**
 * Las partes de aprender de un buzón que se pueden juzgar sin buzón.
 *
 * Todo lo que decide QUÉ entra y QUÉ se propone está escrito como función pura
 * justamente para poder probarlo aquí: son las decisiones que una persona tiene
 * derecho a auditar —qué se archivó de su correo, por qué le propusieron
 * contestarle a alguien— y ninguna debería necesitar una llamada a Google para
 * poder examinarla.
 */

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

describe('el cuerpo de un mensaje', () => {
  it('prefiere el texto plano al HTML, aunque el HTML venga primero', () => {
    const text = extractText({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>hola en HTML</p>') } },
        { mimeType: 'text/plain', body: { data: b64('hola en plano') } },
      ],
    });
    expect(text).toBe('hola en plano');
  });

  it('corta la cita del mensaje anterior, que es la que se repite diez veces', () => {
    const reply = [
      'Confirmado, nos vemos el jueves.',
      '',
      'El 3 de marzo de 2026, Ana Ruiz <ana@naviera.com.co> escribió:',
      '> ¿Les sirve el jueves?',
      '> Ana',
    ].join('\n');
    expect(stripQuotedReply(reply)).toBe('Confirmado, nos vemos el jueves.');
  });

  it('prefiere guardar un mensaje que es sólo cita antes que perderlo', () => {
    const onlyQuote = 'El 3 de marzo de 2026, Ana Ruiz <ana@naviera.com.co> escribió:\n> algo';
    expect(stripQuotedReply(onlyQuote)).toContain('escribió');
  });
});

describe('un mensaje, normalizado', () => {
  const raw = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    // 2026-03-03T15:00:00Z
    internalDate: '1772550000000',
    payload: {
      headers: [
        { name: 'From', value: '"Ana Ruiz" <ana@naviera.com.co>' },
        { name: 'To', value: 'yo@acme.com, luis@acme.com' },
        { name: 'Subject', value: 'Zarpe del jueves' },
        { name: 'Message-ID', value: '<abc@naviera.com.co>' },
        // Una cabecera Date que MIENTE, para comprobar cuál gana.
        { name: 'Date', value: 'Mon, 1 Jan 2001 00:00:00 +0000' },
      ],
      mimeType: 'text/plain',
      body: { data: b64('Confirmamos el zarpe.') },
    },
  };

  it('lee las direcciones y el asunto de las cabeceras', () => {
    const m = normalizeMessage(raw);
    expect(m.fromEmail).toBe('ana@naviera.com.co');
    expect(m.to).toEqual(['yo@acme.com', 'luis@acme.com']);
    expect(m.subject).toBe('Zarpe del jueves');
    expect(m.internetMessageId).toBe('<abc@naviera.com.co>');
    expect(m.body).toBe('Confirmamos el zarpe.');
  });

  it('se fía del reloj de Google y no del que puso el remitente', () => {
    // La cabecera dice 2001; `internalDate` dice 2026. Ordenar un hilo por lo
    // que escribió el cliente del remitente es cómo un hilo se lee al revés.
    expect(normalizeMessage(raw).date?.startsWith('2026')).toBe(true);
  });
});

describe('quiénes están en el hilo', () => {
  it('junta remitentes, destinatarios y copias sin repetir, y en orden', () => {
    const mk = (from: string, to: string[], ms: number) =>
      normalizeMessage({
        id: `m${ms}`,
        threadId: 't1',
        internalDate: String(ms),
        payload: {
          headers: [
            { name: 'From', value: from },
            { name: 'To', value: to.join(', ') },
          ],
        },
      });
    const participants = threadParticipants([
      mk('ana@naviera.com.co', ['yo@acme.com'], 1000),
      mk('yo@acme.com', ['ana@naviera.com.co', 'luis@acme.com'], 2000),
    ]);
    expect(participants).toEqual(['ana@naviera.com.co', 'yo@acme.com', 'luis@acme.com']);
  });
});

describe('la ventana de la carga histórica', () => {
  it('traduce cada ventana a una fecha de Gmail', () => {
    const now = new Date('2026-03-03T00:00:00Z');
    expect(backfillQuery('1m', now)).toContain('after:2026/02/01');
    expect(backfillQuery('90d', now)).toContain('after:2025/12/03');
    expect(backfillQuery('12m', now)).toContain('after:2025/03/03');
  });

  it('deja fuera los mensajes de Chat, que no son correo', () => {
    expect(backfillQuery('90d', new Date('2026-03-03T00:00:00Z'))).toContain('-in:chats');
  });

  it('escribe la fecha como la quiere Gmail', () => {
    expect(gmailDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026/01/05');
  });
});

// ---------------------------------------------------------------------------
// Qué se propone contestar
// ---------------------------------------------------------------------------

const MAILBOX = 'yo@acme.com';

function thread(over: Partial<ArchivedThread> = {}): ArchivedThread {
  return {
    threadId: 't1',
    subject: 'Zarpe del jueves',
    lastMessageAt: '2026-03-03T15:00:00.000Z',
    participants: ['ana@naviera.com.co', MAILBOX],
    counterpartDomain: 'naviera.com.co',
    internalOnly: false,
    documentId: 'doc-1',
    lastFromEmail: 'ana@naviera.com.co',
    lastFrom: '"Ana Ruiz" <ana@naviera.com.co>',
    lastLabelIds: ['INBOX'],
    lastHeaders: [],
    lastSnippet: '¿Nos confirman el zarpe?',
    messages: 2,
    ...over,
  };
}

describe('qué merece un borrador de respuesta', () => {
  const plan = (threads: ArchivedThread[], already = new Set<string>()) =>
    planReplyProposals({ threads, mailbox: MAILBOX, alreadyProposed: already });

  it('propone contestarle a quien escribió último y es de fuera', () => {
    const out = plan([thread()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.to).toBe('ana@naviera.com.co');
  });

  it('no propone nada sobre correo interno', () => {
    expect(plan([thread({ internalOnly: true })])).toHaveLength(0);
  });

  it('no propone contestarse a uno mismo', () => {
    // El último mensaje lo escribió el dueño del buzón: la pelota está fuera.
    expect(plan([thread({ lastFromEmail: MAILBOX, lastFrom: MAILBOX })])).toHaveLength(0);
  });

  it('deja en paz los boletines y lo que Gmail archivó como promoción', () => {
    expect(plan([thread({ lastLabelIds: ['CATEGORY_PROMOTIONS'] })])).toHaveLength(0);
    expect(
      plan([thread({ lastHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:x@y.com>' }] })]),
    ).toHaveLength(0);
  });

  it('no vuelve a proponer un hilo sobre el que ya se propuso algo', () => {
    // Descartar una propuesta es una decisión; re-ofrecerla mañana es discutir.
    expect(plan([thread()], new Set(['t1']))).toHaveLength(0);
  });

  it('pone lo más reciente primero y no pasa de cinco al día', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      thread({
        threadId: `t${i}`,
        lastMessageAt: `2026-03-0${i + 1}T10:00:00.000Z`,
      }),
    );
    const out = plan(many);
    expect(out).toHaveLength(5);
    expect(out[0]?.thread.threadId).toBe('t8');
  });
});
