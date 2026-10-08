import { describe, expect, it } from 'vitest';
import {
  GROUP_SEND_MAX_QUEUE_AGE_MS,
  GROUP_SEND_PER_GROUP_PER_HOUR,
  GROUP_SEND_PER_ORG_PER_DAY,
  capRefusal,
  isRepeat,
  resolveSendGroup,
  textRefusal,
} from '../group-send/rules';
import {
  ackGroupOutbox,
  claimGroupOutbox,
  listGroupMessages,
  queueGroupMessage,
  recordGroupMessages,
} from '../group-send/store';
import { type Row, makeDb } from './fake-db';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const NOW = new Date('2026-10-07T15:00:00Z');

function world(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    whatsapp_groups: [
      { jid: GROUP, subject: 'Despachos Cali', send_enabled: true },
      { jid: OTHER, subject: 'Familia', send_enabled: false },
    ],
    whatsapp_sessions: [{ group_send_paused: false }],
    wa_group_outbox: [],
    wa_group_inbox: [],
    ...extra,
  };
}
const send = (db: ReturnType<typeof makeDb>, group: string, text: string, now = NOW) =>
  queueGroupMessage(db, { group, text, userId: 'u1', via: 'chat', now });

describe('reglas', () => {
  it('topes por grupo/hora y por empresa/día', () => {
    expect(capRefusal({ groupLastHour: 0, orgLastDay: 0 })).toBeNull();
    expect(capRefusal({ groupLastHour: GROUP_SEND_PER_GROUP_PER_HOUR, orgLastDay: 1 })).toMatch(
      /última hora/,
    );
    expect(capRefusal({ groupLastHour: 0, orgLastDay: GROUP_SEND_PER_ORG_PER_DAY })).toMatch(
      /24 horas/,
    );
  });

  it('el texto: vacío, largo o con muchos enlaces se rechaza', () => {
    expect(textRefusal('')).toBeTruthy();
    expect(textRefusal('x'.repeat(1001))).toBeTruthy();
    expect(textRefusal('a http://a.co b http://b.co c http://c.co')).toMatch(/enlaces/);
    expect(textRefusal('Buenos días, ¿nos confirman el vuelo de la guía 045-12345678?')).toBeNull();
  });

  it('repetido: el mismo texto al mismo grupo en pocos minutos', () => {
    const recent = [
      { body: 'Hola  equipo', createdAt: new Date(NOW.getTime() - 120_000).toISOString() },
    ];
    expect(isRepeat('hola equipo', recent, NOW)).toBe(true);
    expect(
      isRepeat('hola equipo', [{ body: 'hola equipo', createdAt: '2026-10-07T10:00:00Z' }], NOW),
    ).toBe(false);
  });

  it('el grupo se resuelve por nombre tolerante o por jid', () => {
    const gs = [
      { jid: GROUP, subject: 'Despachos Cali' },
      { jid: OTHER, subject: 'Despachos Bogotá' },
    ];
    expect(resolveSendGroup(gs, 'despachos cali').kind).toBe('found');
    expect(resolveSendGroup(gs, GROUP).kind).toBe('found');
    expect(resolveSendGroup(gs, 'despachos').kind).toBe('ambiguous');
    expect(resolveSendGroup(gs, 'otro').kind).toBe('none');
  });
});

describe('enviar', () => {
  it('encola a un grupo habilitado, con plantilla ya pintada, y lo registra', async () => {
    const store = world();
    const q = await send(
      makeDb(store),
      'despachos',
      'Buenos días, ¿nos confirman el vuelo de la guía 045-1?',
    );
    expect(q.groupJid).toBe(GROUP);
    expect(store.wa_group_outbox).toHaveLength(1);
    expect(store.wa_group_outbox?.[0]).toMatchObject({ group_jid: GROUP, via: 'chat' });
  });

  it('grupo no habilitado → rechazo (y nada en la cola)', async () => {
    const store = world();
    await expect(send(makeDb(store), 'Familia', 'hola')).rejects.toThrow(
      /no es un grupo habilitado/,
    );
    await expect(send(makeDb(store), OTHER, 'hola')).rejects.toThrow(/habilitado/);
    expect(store.wa_group_outbox).toHaveLength(0);
  });

  it('sin ningún grupo habilitado lo dice', async () => {
    const store = world({ whatsapp_groups: [{ jid: GROUP, subject: 'X', send_enabled: false }] });
    await expect(send(makeDb(store), 'X', 'hola')).rejects.toThrow(/Ningún grupo/);
  });

  it('nunca a un contacto: un jid de persona no pasa aunque esté "habilitado"', async () => {
    const store = world({
      whatsapp_groups: [{ jid: '573001112233@s.whatsapp.net', subject: 'Ana', send_enabled: true }],
    });
    await expect(send(makeDb(store), 'Ana', 'hola')).rejects.toThrow(/grupos, nunca/);
  });

  it('apagado general', async () => {
    const store = world({ whatsapp_sessions: [{ group_send_paused: true }] });
    await expect(send(makeDb(store), 'Despachos', 'hola')).rejects.toThrow(/apagados/);
  });

  it('tope por grupo y hora', async () => {
    const store = world();
    const db = makeDb(store);
    for (let i = 0; i < GROUP_SEND_PER_GROUP_PER_HOUR; i++)
      await send(db, 'Despachos', `mensaje número ${i}`);
    await expect(send(db, 'Despachos', 'uno más')).rejects.toThrow(/última hora/);
  });

  it('tope por empresa y día (repartido en varios grupos)', async () => {
    const store = world({
      whatsapp_groups: Array.from({ length: 6 }, (_, i) => ({
        jid: `12036300000000010${i}@g.us`,
        subject: `Grupo ${i}`,
        send_enabled: true,
      })),
    });
    const db = makeDb(store);
    let ok = 0;
    for (let i = 0; i < GROUP_SEND_PER_ORG_PER_DAY + 5; i++) {
      try {
        await send(db, `Grupo ${i % 6}`, `texto distinto ${i}`, new Date(NOW.getTime() + i * 1000));
        ok++;
      } catch (e) {
        expect((e as Error).message).toMatch(/última hora|24 horas/);
      }
    }
    expect(ok).toBeLessThanOrEqual(GROUP_SEND_PER_ORG_PER_DAY);
    expect(store.wa_group_outbox?.length).toBe(ok);
  });

  it('el mismo texto no se repite', async () => {
    const db = makeDb(world());
    await send(db, 'Despachos', 'Hola, ¿novedades?');
    await expect(send(db, 'Despachos', 'hola novedades')).rejects.toThrow(/no se repite/);
  });
});

describe('entrega por el puente', () => {
  it('reclama lo pendiente, descarta lo caducado o de un grupo que ya no está habilitado, y acusa recibo', async () => {
    const store = world();
    const db = makeDb(store);
    await send(db, 'Despachos', 'primero');
    store.wa_group_outbox?.push({
      id: 'old',
      group_jid: GROUP,
      body: 'viejo',
      status: 'pendiente',
      created_at: new Date(NOW.getTime() - GROUP_SEND_MAX_QUEUE_AGE_MS - 1000).toISOString(),
    });
    const items = await claimGroupOutbox(db, { now: NOW });
    expect(items.map((i) => i.text)).toEqual(['primero']);
    expect(store.wa_group_outbox?.find((r) => r.id === 'old')?.status).toBe('cancelado');
    const id = items[0]?.id as string;
    await ackGroupOutbox(db, { id, ok: true, messageId: 'WAID1', now: NOW });
    expect(store.wa_group_outbox?.find((r) => r.id === id)).toMatchObject({
      status: 'enviado',
      wa_message_id: 'WAID1',
    });
    // lo enviado queda en el hilo, como mensaje de Cortex
    expect(store.wa_group_inbox?.[0]).toMatchObject({ from_me: true, message_id: 'WAID1' });
  });

  it('apagado general: no entrega nada', async () => {
    const store = world();
    const db = makeDb(store);
    await send(db, 'Despachos', 'hola');
    store.whatsapp_sessions = [{ group_send_paused: true }];
    expect(await claimGroupOutbox(db, { now: NOW })).toEqual([]);
  });
});

describe('capturar la respuesta', () => {
  it('guarda sólo de grupos habilitados y se lee con cita y filtro por texto', async () => {
    const store = world();
    const db = makeDb(store);
    const q = await send(db, 'Despachos', 'Buenos días, ¿vuelo de la guía 045-12345678?');
    const [item] = await claimGroupOutbox(db, { now: NOW });
    await ackGroupOutbox(db, { id: item?.id as string, ok: true, messageId: 'Q1', now: NOW });
    expect(q.groupJid).toBe(GROUP);

    const at = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
    const stored = await recordGroupMessages(
      db,
      [
        {
          groupJid: GROUP,
          messageId: 'R1',
          senderName: 'Luis',
          sentAt: at(5),
          body: 'Va en AV204',
          quotedMessageId: 'Q1',
          quotedBody: '¿vuelo de la guía 045-12345678?',
        },
        {
          groupJid: GROUP,
          messageId: 'R2',
          senderName: 'Ana',
          sentAt: at(6),
          body: 'buen día a todos',
        },
        {
          groupJid: OTHER,
          messageId: 'X1',
          senderName: 'Tía',
          sentAt: at(7),
          body: 'no habilitado',
        },
      ],
      new Date(at(10)),
    );
    expect(stored).toBe(2);
    expect(store.wa_group_inbox?.some((r) => r.group_jid === OTHER)).toBe(false);

    const all = await listGroupMessages(db, {
      group: 'Despachos',
      sinceHours: 24,
      limit: 50,
      now: new Date(at(10)),
    });
    expect(all.messages.map((m) => m.id)).toEqual(['Q1', 'R1', 'R2']);
    const reply = all.messages.find((m) => m.id === 'R1');
    expect(reply).toMatchObject({ from: 'Luis', quotesId: 'Q1' });

    const filtered = await listGroupMessages(db, {
      group: 'Despachos',
      sinceHours: 24,
      contains: '045-12345678',
      limit: 50,
      now: new Date(at(10)),
    });
    expect(filtered.messages.map((m) => m.id)).toEqual(['Q1', 'R1']);
    await expect(
      listGroupMessages(db, { group: 'Familia', sinceHours: 24, limit: 5, now: NOW }),
    ).rejects.toThrow(/habilitado/);
  });

  it('borra lo de más de 7 días', async () => {
    const store = world({
      wa_group_inbox: [
        { group_jid: GROUP, message_id: 'viejo', sent_at: '2026-09-01T00:00:00Z', body: 'x' },
      ],
    });
    await recordGroupMessages(
      makeDb(store),
      [{ groupJid: GROUP, messageId: 'n', sentAt: NOW.toISOString(), body: 'hola' }],
      NOW,
    );
    expect(store.wa_group_inbox?.map((r) => r.message_id)).toEqual(['n']);
  });
});
