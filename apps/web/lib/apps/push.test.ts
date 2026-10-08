import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../../packages/agent-tools/src/tenancy/scoped-client';
import { decideAutomationCall } from './automation-ask-cortex';
import {
  type PushSender,
  type VapidConfig,
  pushToAppUsers,
  safePushUrl,
  saveSubscription,
  validSubscription,
  vapidConfig,
} from './push';

/**
 * WEB PUSH (0210): sin llaves no hay push (y por tanto el motor cae a correo),
 * una suscripción vencida se borra, y un aviso sólo llega a quienes se
 * suscribieron EN ESA app.
 */

const ORG = 'org-a';
const VAPID: VapidConfig = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.co' };

function world() {
  const sub = (id: string, appId: string, userId: string, endpoint: string) => ({
    id,
    organization_id: ORG,
    app_id: appId,
    subject_kind: 'app_user',
    member_id: null,
    app_user_id: userId,
    endpoint,
    p256dh: 'p',
    auth: 'a',
  });
  const fake = createFakeSupabase({
    push_subscriptions: [
      sub('s1', 'app-1', 'u1', 'https://push.example/1'),
      sub('s2', 'app-1', 'u2', 'https://push.example/2'),
      sub('s3', 'app-2', 'u1', 'https://push.example/3'),
    ],
  });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

const payload = { title: 't', url: '/a/app-1/inicio', tag: 'x' };

describe('llaves VAPID', () => {
  it('sin las tres, el push está apagado', () => {
    expect(vapidConfig({} as never)).toBeNull();
    expect(vapidConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' } as never)).toBeNull();
    expect(
      vapidConfig({
        VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
        VAPID_SUBJECT: 'nada',
      } as never),
    ).toBeNull();
    expect(
      vapidConfig({
        VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
        VAPID_SUBJECT: 'mailto:x@y.co',
      } as never),
    ).toEqual({ publicKey: 'a', privateKey: 'b', subject: 'mailto:x@y.co' });
  });

  it('sin llaves no se manda NADA y no llega a nadie (el llamador cae a correo)', async () => {
    const { db } = world();
    const send = vi.fn<PushSender>();
    const out = await pushToAppUsers(db, 'app-1', ['u1', 'u2'], payload, send, null);
    expect(out).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('envío', () => {
  it('sólo a las suscripciones de ESA app y de esos usuarios', async () => {
    const { db } = world();
    const send = vi.fn<PushSender>(async () => {});
    const out = await pushToAppUsers(db, 'app-1', ['u1'], payload, send, VAPID);
    expect(out).toEqual(['u1']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].endpoint).toBe('https://push.example/1');
    // la suscripción de u1 en otra app no se tocó
  });

  it('una suscripción vencida (410) se borra; las demás siguen', async () => {
    const { db, fake } = world();
    const send: PushSender = async (sub) => {
      if (sub.endpoint.endsWith('/1')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    };
    const out = await pushToAppUsers(db, 'app-1', ['u1', 'u2'], payload, send, VAPID);
    expect(out).toEqual(['u2']);
    expect(fake.tables.push_subscriptions?.map((s) => s.id).sort()).toEqual(['s2', 's3']);
  });

  it('un fallo pasajero no borra la suscripción ni cuenta como entregado', async () => {
    const { db, fake } = world();
    const send: PushSender = async () => {
      throw Object.assign(new Error('boom'), { statusCode: 503 });
    };
    expect(await pushToAppUsers(db, 'app-1', ['u1'], payload, send, VAPID)).toEqual([]);
    expect(fake.tables.push_subscriptions).toHaveLength(3);
  });

  it('el aviso nunca abre otro sitio', () => {
    expect(safePushUrl('/a/app-1/inicio', 'app-1')).toBe('/a/app-1/inicio');
    expect(safePushUrl('https://evil.example', 'app-1')).toBe('/a/app-1');
    expect(safePushUrl('//evil.example', 'app-1')).toBe('/a/app-1');
    expect(safePushUrl('/a/otra-app/x', 'app-1')).toBe('/a/app-1');
  });
});

describe('suscribirse', () => {
  it('valida la forma y guarda; el mismo endpoint cambia de dueño en vez de duplicarse', async () => {
    const { db, fake } = world();
    expect(
      validSubscription({ endpoint: 'http://inseguro', keys: { p256dh: 'a', auth: 'b' } }),
    ).toBeNull();
    expect(validSubscription({ endpoint: 'https://push.example/abc123456', keys: {} })).toBeNull();
    const sub = validSubscription({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'nuevo', auth: 'x' },
    });
    expect(sub).not.toBeNull();
    if (!sub) return;
    await saveSubscription(db, {
      appId: 'app-1',
      subject: { kind: 'app_user', appUserId: 'u9' },
      subscription: sub,
      userAgent: 'Chrome',
    });
    const rows = (fake.tables.push_subscriptions ?? []).filter(
      (s) => s.endpoint === 'https://push.example/1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.app_user_id).toBe('u9');
  });
});

describe('Cortex en una automatización: qué corre y qué espera aprobación', () => {
  it('lee y escribe en la tabla de la regla; todo lo demás se detiene', () => {
    expect(decideAutomationCall({ id: 'trackers.query' }, {}, 'guias')).toBe('run');
    expect(decideAutomationCall({ id: 'trackers.upsert' }, { tracker: 'guias' }, 'guias')).toBe(
      'run',
    );
    // otra tabla: a aprobación
    expect(decideAutomationCall({ id: 'trackers.upsert' }, { tracker: 'otra' }, 'guias')).toBe(
      'stage',
    );
    // una escritura cualquiera, aunque la herramienta no pida confirmación
    expect(decideAutomationCall({ id: 'gmail.send_draft' }, {}, 'guias')).toBe('stage');
    // lo que ya pide confirmación, también
    expect(
      decideAutomationCall({ id: 'trackers.query', requiresConfirmation: true }, {}, 'guias'),
    ).toBe('stage');
    // una regla no se reescribe a sí misma
    expect(decideAutomationCall({ id: 'apps.automations.create' }, {}, 'guias')).toBe('forbidden');
    expect(decideAutomationCall({ id: 'apps.update' }, {}, 'guias')).toBe('forbidden');
  });

  it('lo que la regla declara en `allow` corre sin aprobación; lo demás no', () => {
    const declared = new Set(['whatsapp.group_send']);
    expect(
      decideAutomationCall(
        { id: 'whatsapp.group_send', requiresConfirmation: true },
        {},
        'guias',
        null,
        declared,
      ),
    ).toBe('declared');
    // declarar una herramienta no suelta las demás
    expect(
      decideAutomationCall(
        { id: 'gdrive.upload_file', requiresConfirmation: true },
        {},
        'guias',
        null,
        declared,
      ),
    ).toBe('stage');
    // sin declarar, pide aprobación
    expect(
      decideAutomationCall({ id: 'whatsapp.group_send', requiresConfirmation: true }, {}, 'guias'),
    ).toBe('stage');
  });
});
