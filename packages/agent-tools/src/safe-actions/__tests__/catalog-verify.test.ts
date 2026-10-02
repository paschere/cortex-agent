import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext } from '../../types';
import { SAFE_ACTION_CATALOG } from '../catalog';
import type { SafeActionPolicy, VerifyOutcome } from '../types';

/**
 * Las verificaciones del catálogo, contra respuestas de proveedor fingidas.
 * Lo que importa de cada una es la frontera entre las tres respuestas: «está»,
 * «no está» (404 o estado incoherente) y «no pude mirar» (cualquier otro fallo).
 */

const ORG = 'org-acme';

function ctxWith(db = createFakeSupabase({}).client): ToolContext {
  return {
    organizationId: ORG,
    userId: '11111111-1111-4111-8111-111111111111',
    agentId: '33333333-3333-4333-8333-333333333333',
    db: createOrgScopedClient(db, ORG),
    integrations: {
      getAccessToken: vi.fn().mockResolvedValue({ token: 't', scopes: [] }),
      hasScopes: vi.fn().mockResolvedValue(true),
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as ToolContext['logger'],
  };
}

function verifyOf(id: string) {
  const policy = SAFE_ACTION_CATALOG[id] as unknown as SafeActionPolicy<unknown, unknown>;
  if (!policy.verify) throw new Error(`${id} sin verify`);
  return (input: unknown, output: unknown, ctx: ToolContext): Promise<VerifyOutcome> =>
    policy.verify?.({ input, output, ctx, startedAt: new Date() }) as Promise<VerifyOutcome>;
}

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gmail.send_message', () => {
  const verify = verifyOf('gmail.send_message');

  it('con la etiqueta SENT, verificado', async () => {
    respond(200, { id: 'm1', labelIds: ['SENT'] });
    expect(await verify({}, { messageId: 'm1' }, ctxWith())).toEqual({
      status: 'verified',
      detail: 'el correo está en Enviados.',
    });
  });

  it('404: no verificado', async () => {
    respond(404, { error: 'not found' });
    expect((await verify({}, { messageId: 'm1' }, ctxWith())).status).toBe('not_verified');
  });

  it('500: no se pudo verificar', async () => {
    respond(500, { error: 'boom' });
    expect((await verify({}, { messageId: 'm1' }, ctxWith())).status).toBe('unverifiable');
  });
});

describe('gcal.create_event', () => {
  const verify = verifyOf('gcal.create_event');

  it('el evento existe: verificado', async () => {
    respond(200, { id: 'e1', status: 'confirmed' });
    expect(
      (await verify({ calendarId: 'primary' }, { event: { id: 'e1' } }, ctxWith())).status,
    ).toBe('verified');
  });

  it('el evento aparece cancelado: no verificado', async () => {
    respond(200, { id: 'e1', status: 'cancelled' });
    expect((await verify({}, { event: { id: 'e1' } }, ctxWith())).status).toBe('not_verified');
  });
});

describe('payments.record y trackers.upsert: la fila existe', () => {
  it('pago encontrado / no encontrado / sin id', async () => {
    const verify = verifyOf('payments.record');
    const { client } = createFakeSupabase({ payments: [{ id: 'p1', organization_id: ORG }] });
    expect((await verify({}, { paymentId: 'p1' }, ctxWith(client))).status).toBe('verified');
    expect((await verify({}, { paymentId: 'p2' }, ctxWith(client))).status).toBe('not_verified');
    expect((await verify({}, { paymentId: null }, ctxWith(client))).status).toBe('unverifiable');
  });

  it('una fila de otra empresa no cuenta como verificada', async () => {
    const verify = verifyOf('trackers.upsert');
    const { client } = createFakeSupabase({
      tracker_rows: [{ id: 'r1', organization_id: 'org-globex' }],
    });
    expect((await verify({}, { row: { id: 'r1' } }, ctxWith(client))).status).toBe('not_verified');
  });
});
