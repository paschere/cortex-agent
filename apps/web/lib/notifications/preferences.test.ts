import { NOTIFICATION_KINDS } from '@/lib/notifications-shape';
import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { notify } from './notify';
import {
  briefingOff,
  emailAllowedUsers,
  loadPreferencesFor,
  sanitizePreferencesInput,
  savePreferences,
} from './preferences';
import {
  CATEGORY_INFO,
  CATEGORY_OF_KIND,
  DEFAULT_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  anyChannelChosen,
  bogotaMinutes,
  inQuietHours,
  kindsOfCategory,
  parsePreferences,
  resolveChannels,
} from './preferences-shape';
import { pushToPeople } from './push';

const ACME = 'org-acme';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';

// 14:00 en Bogotá = 19:00 UTC; 23:30 Bogotá = 04:30 UTC del día siguiente; 06:00 Bogotá = 11:00 UTC.
const MIDDAY = new Date('2026-10-12T19:00:00Z');
const LATE = new Date('2026-10-13T04:30:00Z');
const EARLY = new Date('2026-10-12T11:00:00Z');

function world(tables: Tables = {}) {
  const t: Tables = {
    notifications: [],
    notification_preferences: [],
    push_subscriptions: [],
    ...tables,
  };
  const fake = createFakeSupabase(t);
  const raw = fake.client as SupabaseClient;
  // El fake no genera ids ni defaults de `notifications`.
  const inner = raw as unknown as { from: (n: string) => Record<string, unknown> };
  let seq = 0;
  const withIds = {
    from(table: string) {
      const b = inner.from(table);
      const original = b.insert as (rows: unknown) => unknown;
      b.insert = (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list as Record<string, unknown>[]) {
          seq += 1;
          row.id ??= `${table}-${seq}`;
          row.created_at ??= new Date().toISOString();
          row.occurred_at ??= row.created_at;
          row.read_at ??= null;
          row.occurrences ??= 1;
        }
        return original.call(b, list);
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { tables: t, db: createOrgScopedClient(withIds, ACME) };
}

describe('categorías', () => {
  it('toda clase de aviso tiene categoría, y toda categoría tiene texto y clases', () => {
    for (const kind of NOTIFICATION_KINDS) expect(CATEGORY_OF_KIND[kind]).toBeTruthy();
    expect(Object.keys(CATEGORY_OF_KIND).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(CATEGORY_INFO.map((c) => c.id).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
    for (const c of NOTIFICATION_CATEGORIES) expect(kindsOfCategory(c).length).toBeGreaterThan(0);
  });
});

describe('resolución de canales', () => {
  it('sin preferencias es el comportamiento de hoy: campana, celular y correo; WhatsApp no', () => {
    expect(resolveChannels(null, 'briefing', MIDDAY)).toEqual({
      bell: true,
      push: true,
      email: true,
      whatsapp: false,
    });
    expect(resolveChannels(DEFAULT_PREFERENCES, 'task_failed', MIDDAY).email).toBe(true);
  });

  it('lo apagado en una categoría sólo afecta a esa categoría', () => {
    const prefs = parsePreferences({ channels: { briefing: { email: false, push: false } } });
    const brief = resolveChannels(prefs, 'briefing', MIDDAY);
    expect(brief).toMatchObject({ bell: true, push: false, email: false });
    expect(resolveChannels(prefs, 'task_finished', MIDDAY)).toMatchObject({
      push: true,
      email: true,
    });
  });

  it('«Tu día» apagado del todo se detecta; con un canal encendido no', () => {
    const off = parsePreferences({
      channels: { briefing: { bell: false, push: false, email: false } },
    });
    expect(anyChannelChosen(off, 'briefing')).toBe(false);
    expect(briefingOff(off)).toBe(true);
    expect(
      briefingOff(parsePreferences({ channels: { briefing: { bell: false, push: false } } })),
    ).toBe(false);
    expect(briefingOff(undefined)).toBe(false);
  });

  it('WhatsApp elegido no se manda mientras el puente no envíe a personas', () => {
    const prefs = parsePreferences({ channels: { briefing: { whatsapp: true } } });
    expect(resolveChannels(prefs, 'briefing', MIDDAY).whatsapp).toBe(false);
    expect(resolveChannels(prefs, 'briefing', MIDDAY, { whatsappAvailable: true }).whatsapp).toBe(
      true,
    );
    expect(
      resolveChannels(parsePreferences({ channels: {} }), 'briefing', MIDDAY, {
        whatsappAvailable: true,
      }).whatsapp,
    ).toBe(false);
  });

  it('lo malformado cae al defecto y lo desconocido se ignora', () => {
    const prefs = parsePreferences({
      channels: { briefing: { email: 'no', bell: false, otro: true }, inventada: { bell: false } },
      quiet_enabled: 'sí',
      quiet_start: '25:99',
      quiet_end: '07:00',
    });
    expect(prefs.channels).toEqual({ briefing: { bell: false } });
    expect(prefs.quiet).toEqual({ enabled: false, start: '22:00', end: '07:00' });
  });
});

describe('horas de silencio', () => {
  const quiet = { enabled: true, start: '22:00', end: '07:00' };

  it('la hora de Bogotá es UTC-5', () => {
    expect(bogotaMinutes(MIDDAY)).toBe(14 * 60);
    expect(bogotaMinutes(LATE)).toBe(23 * 60 + 30);
    expect(bogotaMinutes(new Date('2026-10-12T02:00:00Z'))).toBe(21 * 60);
  });

  it('cruza la medianoche', () => {
    expect(inQuietHours(quiet, LATE)).toBe(true);
    expect(inQuietHours(quiet, EARLY)).toBe(true);
    expect(inQuietHours(quiet, MIDDAY)).toBe(false);
    // 07:00 en punto ya no es silencio: el resumen de las 7 sale.
    expect(inQuietHours(quiet, new Date('2026-10-12T12:00:00Z'))).toBe(false);
  });

  it('un rango dentro del mismo día, y apagado nunca silencia', () => {
    expect(inQuietHours({ enabled: true, start: '12:00', end: '15:00' }, MIDDAY)).toBe(true);
    expect(inQuietHours({ enabled: true, start: '12:00', end: '13:00' }, MIDDAY)).toBe(false);
    expect(inQuietHours({ ...quiet, enabled: false }, LATE)).toBe(false);
    expect(inQuietHours({ enabled: true, start: '08:00', end: '08:00' }, MIDDAY)).toBe(false);
  });

  it('en silencio: celular, correo y WhatsApp se detienen; la campana sigue', () => {
    const prefs = parsePreferences({
      channels: { briefing: { whatsapp: true } },
      quiet_enabled: true,
      quiet_start: '22:00',
      quiet_end: '07:00',
    });
    expect(resolveChannels(prefs, 'briefing', LATE, { whatsappAvailable: true })).toEqual({
      bell: true,
      push: false,
      email: false,
      whatsapp: false,
    });
    expect(resolveChannels(prefs, 'briefing', MIDDAY).push).toBe(true);
  });
});

describe('aplicación en el servidor', () => {
  it('guardar y leer: sólo se guardan las diferencias y cada quien tiene la suya', async () => {
    const { db, tables } = world();
    await savePreferences(db, ANA, {
      channels: { briefing: { bell: true, email: false }, tasks: { push: true } },
      quiet: { enabled: true, start: '21:00', end: '06:30' },
    });
    const row = tables.notification_preferences?.[0] as Record<string, unknown>;
    expect(row.organization_id).toBe(ACME);
    expect(row.channels).toEqual({ briefing: { email: false } });
    expect(await loadPreferencesFor(db, ANA)).toMatchObject({
      channels: { briefing: { email: false } },
      quiet: { enabled: true, start: '21:00', end: '06:30' },
    });
    expect(await loadPreferencesFor(db, BETO)).toEqual(DEFAULT_PREFERENCES);
  });

  it('rechaza horas mal escritas', () => {
    expect(
      sanitizePreferencesInput({
        channels: {},
        quiet: { enabled: true, start: '9', end: '07:00' },
      }),
    ).toBeNull();
    expect(
      sanitizePreferencesInput({
        channels: {},
        quiet: { enabled: true, start: '09:00', end: '07:00' },
      }),
    ).not.toBeNull();
  });

  it('notify() no escribe la campana de una categoría que la persona apagó, y a los demás sí', async () => {
    const { db, tables } = world();
    await savePreferences(db, ANA, {
      channels: { tasks: { bell: false } },
      quiet: { enabled: false, start: '22:00', end: '07:00' },
    });
    const off = await notify(db, { userId: ANA, kind: 'task_finished', title: 'Terminó la tarea' });
    expect(off).toBeNull();
    expect(tables.notifications).toHaveLength(0);
    // Otra categoría de la misma persona, y la misma categoría de otra persona.
    expect(
      await notify(db, { userId: ANA, kind: 'task_failed', title: 'Falló la tarea' }),
    ).toBeTruthy();
    expect(
      await notify(db, { userId: BETO, kind: 'task_finished', title: 'Terminó la tarea' }),
    ).toBeTruthy();
    expect(tables.notifications).toHaveLength(2);
  });

  it('notify() sigue funcionando si la tabla de preferencias no está (falla abierto)', async () => {
    const t: Tables = { notifications: [] };
    const fake = createFakeSupabase(t);
    const db = createOrgScopedClient(fake.client as SupabaseClient, ACME);
    const inner = db as unknown as { from: (n: string) => Record<string, unknown> };
    const broken = {
      from(table: string) {
        if (table === 'notification_preferences') throw new Error('relation does not exist');
        const b = inner.from(table);
        const original = b.insert as (rows: unknown) => unknown;
        b.insert = (rows: unknown) => {
          for (const r of (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[]) {
            r.id ??= 'n-1';
            r.occurrences ??= 1;
          }
          return original.call(b, rows);
        };
        return b;
      },
    } as unknown as SupabaseClient;
    Object.assign(broken, { __org: ACME });
    expect(await loadPreferencesFor(broken, ANA)).toEqual(DEFAULT_PREFERENCES);
  });

  it('el correo se le quita a quien lo apagó o está en silencio, no al resto', async () => {
    const { db } = world();
    await savePreferences(db, ANA, {
      channels: { receivables: { email: false } },
      quiet: { enabled: false, start: '22:00', end: '07:00' },
    });
    await savePreferences(db, BETO, {
      channels: {},
      quiet: { enabled: true, start: '22:00', end: '07:00' },
    });
    expect([...(await emailAllowedUsers(db, [ANA, BETO], 'receivables_overdue', MIDDAY))]).toEqual([
      BETO,
    ]);
    expect([...(await emailAllowedUsers(db, [ANA, BETO], 'receivables_overdue', LATE))]).toEqual(
      [],
    );
    expect([...(await emailAllowedUsers(db, [ANA, BETO], 'task_finished', MIDDAY))].sort()).toEqual(
      [ANA, BETO].sort(),
    );
  });

  it('el celular sólo llega a quien lo tiene encendido y fuera del silencio', async () => {
    const { db } = world({
      push_subscriptions: [
        {
          id: 's1',
          endpoint: 'e1',
          p256dh: 'p',
          auth: 'a',
          member_id: ANA,
          subject_kind: 'member',
          app_id: null,
          organization_id: ACME,
        },
        {
          id: 's2',
          endpoint: 'e2',
          p256dh: 'p',
          auth: 'a',
          member_id: BETO,
          subject_kind: 'member',
          app_id: null,
          organization_id: ACME,
        },
      ],
    });
    await savePreferences(db, ANA, {
      channels: { briefing: { push: false } },
      quiet: { enabled: false, start: '22:00', end: '07:00' },
    });
    const sent: string[] = [];
    const send = async (sub: { endpoint: string }) => {
      sent.push(sub.endpoint);
    };
    const vapid = { subject: 'mailto:x@y.z', publicKey: 'p', privateKey: 'k' };
    const delivered = await pushToPeople(
      db,
      [ANA, BETO],
      { title: 't', url: '/notifications', tag: 'x', kind: 'briefing' },
      send as never,
      vapid as never,
    );
    expect(delivered).toEqual([BETO]);
    expect(sent).toEqual(['e2']);
    // Sin `kind` no se filtra (un envío que no es un aviso de la campana).
    sent.length = 0;
    await pushToPeople(
      db,
      [ANA, BETO],
      { title: 't', url: '/x', tag: 'y' },
      send as never,
      vapid as never,
    );
    expect(sent.sort()).toEqual(['e1', 'e2']);
  });
});
