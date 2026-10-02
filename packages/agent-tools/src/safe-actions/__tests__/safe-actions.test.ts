import { ConfirmationRequiredError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getTool, listTools, registerTool, runTool } from '../../index';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext, ToolDef } from '../../types';
import { canonicalJson, idempotencyKey } from '../canonical';
import { SAFE_ACTION_CATALOG } from '../catalog';
import { findPriorAction } from '../prior';
import { ActionInFlightError, ActionOutcomeUnknownError, REPEAT_FLAG } from '../runtime';

/**
 * ACCIONES SEGURAS DE REPETIR, CONTRA UNA BASE QUE SE COMPORTA COMO UNA BASE.
 *
 * El doble de PostgREST de tenancy ejecuta los filtros de verdad; aquí se le
 * añade lo único que le falta para este caso: la restricción única de
 * (organization_id, key), comprobada en el momento de ejecutar la sentencia y
 * no al construirla — que es donde vive la carrera entre dos workers.
 */

const ORG = 'org-acme';
const OTHER_ORG = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';

function withUniqueKey(client: SupabaseClient, tables: Tables): SupabaseClient {
  const raw = client as unknown as {
    from: (t: string) => Record<string, unknown>;
    rpc: unknown;
  };
  return {
    rpc: raw.rpc,
    from(table: string) {
      const q = raw.from(table) as { insert: (v: unknown) => PromiseLike<unknown> };
      if (table !== 'action_idempotency') return q;
      const original = q.insert.bind(q);
      q.insert = ((values: unknown) => ({
        // biome-ignore lint/suspicious/noThenProperty: imita el builder de PostgREST
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          const rows = (Array.isArray(values) ? values : [values]) as Array<
            Record<string, unknown>
          >;
          const clash = rows.some((r) =>
            (tables.action_idempotency ?? []).some(
              (x) => x.organization_id === r.organization_id && x.key === r.key,
            ),
          );
          if (clash) {
            return Promise.resolve({
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint' },
            }).then(resolve, reject);
          }
          return original(values).then(resolve, reject);
        },
      })) as unknown as typeof q.insert;
      return q;
    },
  } as unknown as SupabaseClient;
}

function setup(org = ORG) {
  const tables: Tables = { action_idempotency: [], audit_events: [] };
  const fake = createFakeSupabase(tables);
  const raw = withUniqueKey(fake.client, tables);
  const ctxFor = (userId = ANA, overrides: Partial<ToolContext> = {}): ToolContext => ({
    organizationId: org,
    userId,
    agentId: AGENT,
    conversationId: '44444444-4444-4444-8444-444444444444',
    surface: 'web',
    db: createOrgScopedClient(raw, org),
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as ToolContext['logger'],
    ...overrides,
  });
  return { tables, raw, ctxFor };
}

let seq = 0;
function sendTool(
  opts: {
    handler?: ToolDef<{ to: string; body: string }, { messageId: string }>['handler'];
    verify?: NonNullable<
      ToolDef<{ to: string; body: string }, { messageId: string }>['safeAction']
    >['verify'];
    requiresConfirmation?: boolean;
    windowMs?: number;
  } = {},
) {
  seq += 1;
  const handler = vi.fn(
    opts.handler ??
      (async (input: { to: string; body: string }) => ({ messageId: `m-${input.to}-${seq}` })),
  );
  const tool = registerTool<{ to: string; body: string }, { messageId: string }>({
    id: `test.safe_send_${seq}`,
    description: 'manda algo',
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    outputSchema: z.object({ messageId: z.string() }),
    requiresConfirmation: opts.requiresConfirmation,
    safeAction: {
      windowMs: opts.windowMs ?? 24 * 60 * 60_000,
      noun: 'el correo',
      verify: opts.verify,
    },
    handler,
  });
  return { tool, handler };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------

describe('la huella', () => {
  const base = { organizationId: ORG, actorId: ANA, toolId: 'gmail.send_message' };

  it('no depende del orden de las claves', () => {
    const a = idempotencyKey({
      ...base,
      input: { to: ['x@y.co'], subject: 'Hola', body: 'Cuerpo' },
    });
    const b = idempotencyKey({
      ...base,
      input: { body: 'Cuerpo', subject: 'Hola', to: ['x@y.co'] },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no depende del espacio sobrante ni de null contra ausente', () => {
    const a = idempotencyKey({
      ...base,
      input: { subject: '  Hola   mundo ', body: 'a\n\nb', cc: null },
    });
    const b = idempotencyKey({ ...base, input: { subject: 'Hola mundo', body: 'a b' } });
    expect(a).toBe(b);
  });

  it('canoniza objetos anidados y respeta el orden de los arreglos', () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"b":{"x":2,"y":1}}');
    const a = idempotencyKey({ ...base, input: { to: ['a@x.co', 'b@x.co'] } });
    const b = idempotencyKey({ ...base, input: { to: ['b@x.co', 'a@x.co'] } });
    expect(a).not.toBe(b);
  });

  it('separa por persona, empresa, herramienta y alcance', () => {
    const k = idempotencyKey({ ...base, input: { x: 1 } });
    expect(idempotencyKey({ ...base, actorId: BEN, input: { x: 1 } })).not.toBe(k);
    expect(idempotencyKey({ ...base, organizationId: OTHER_ORG, input: { x: 1 } })).not.toBe(k);
    expect(idempotencyKey({ ...base, toolId: 'outlook.send_draft', input: { x: 1 } })).not.toBe(k);
    expect(idempotencyKey({ ...base, input: { x: 1 }, scope: 'routine:r:1' })).not.toBe(k);
  });
});

describe('runTool con una acción segura de repetir', () => {
  it('dos llamadas a la vez: una ejecuta, la otra se entera de que está en vuelo', async () => {
    const { ctxFor, tables } = setup();
    const gate = deferred<void>();
    const { tool, handler } = sendTool({
      handler: async () => {
        await gate.promise;
        return { messageId: 'm-1' };
      },
    });
    const input = { to: 'ana@cliente.co', body: 'La factura' };

    const first = runTool(tool, input, ctxFor());
    const second = runTool(tool, { body: 'La factura', to: 'ana@cliente.co' }, ctxFor());
    const secondSettled = second.then(
      () => 'ok',
      (e) => e,
    );
    // Deja que ambas lleguen al reclamo antes de soltar la primera.
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();

    await expect(first).resolves.toMatchObject({ messageId: 'm-1' });
    expect(await secondSettled).toBeInstanceOf(ActionInFlightError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tables.action_idempotency).toHaveLength(1);
    expect(tables.action_idempotency?.[0]).toMatchObject({
      organization_id: ORG,
      status: 'succeeded',
    });
    expect(
      tables.audit_events?.some(
        (r) => (r.metadata as Record<string, unknown>)?.reason === 'idempotency_in_flight',
      ),
    ).toBe(true);
  });

  it('la repetición devuelve el resultado anterior con el aviso, sin ejecutar', async () => {
    const { ctxFor, tables } = setup();
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };

    const first = await runTool(tool, input, ctxFor());
    const again = (await runTool(tool, { ...input, body: ' Hola ' }, ctxFor())) as Record<
      string,
      unknown
    >;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(again.messageId).toBe(first.messageId);
    const notice = again._idempotency as { outcome: string; notice: string; howToRepeat: string };
    expect(notice.outcome).toBe('replayed');
    expect(notice.notice).toMatch(/^Ya lo había hecho a las \d{2}:\d{2}; no lo repetí\./);
    expect(notice.howToRepeat).toContain(REPEAT_FLAG);
    // Viaja en JSON: el modelo lo lee.
    expect(JSON.parse(JSON.stringify(again))._idempotency.outcome).toBe('replayed');
    expect(
      tables.audit_events?.filter(
        (r) => (r.metadata as Record<string, unknown>)?.reason === 'idempotent_replay',
      ),
    ).toHaveLength(1);
  });

  it('lo ya hecho no vuelve a pedir confirmación', async () => {
    const { ctxFor } = setup();
    const { tool, handler } = sendTool({ requiresConfirmation: true });
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor(), { confirmed: true });
    const again = (await runTool(tool, input, ctxFor())) as Record<string, unknown>;
    expect(handler).toHaveBeenCalledTimes(1);
    expect((again._idempotency as { outcome: string }).outcome).toBe('replayed');
  });

  it('otra persona, u otra empresa, no hereda la huella', async () => {
    const acme = setup(ORG);
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, acme.ctxFor(ANA));
    await runTool(tool, input, acme.ctxFor(BEN));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(acme.tables.action_idempotency).toHaveLength(2);
  });

  it('un fallo libera la clave: el reintento ejecuta', async () => {
    const { ctxFor, tables } = setup();
    let calls = 0;
    const { tool, handler } = sendTool({
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Gmail 503');
        return { messageId: 'm-ok' };
      },
    });
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await expect(runTool(tool, input, ctxFor())).rejects.toThrow('Gmail 503');
    expect(tables.action_idempotency?.[0]).toMatchObject({ status: 'failed' });

    await expect(runTool(tool, input, ctxFor())).resolves.toMatchObject({ messageId: 'm-ok' });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(tables.action_idempotency?.[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('repetir a sabiendas ejecuta, y la herramienta nunca ve el campo', async () => {
    const { ctxFor } = setup();
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor());
    const again = (await runTool(tool, { ...input, [REPEAT_FLAG]: true }, ctxFor())) as Record<
      string,
      unknown
    >;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual(input);
    expect((again._idempotency as { outcome: string; notice: string }).outcome).toBe('repeated');
  });

  it('la aprobación que avisó de la repetición ejecuta con allowRepeat', async () => {
    const { ctxFor } = setup();
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor(), { confirmed: true });
    await runTool(tool, input, ctxFor(), { confirmed: true, allowRepeat: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('la petición de confirmación conserva el campo de repetir para la tarjeta', async () => {
    const { ctxFor } = setup();
    const { tool } = sendTool({ requiresConfirmation: true });
    const input = { to: 'ana@cliente.co', body: 'Hola', [REPEAT_FLAG]: true };
    const err = await runTool(tool, input, ctxFor()).catch((e) => e);
    expect(err).toBeInstanceOf(ConfirmationRequiredError);
    expect((err as ConfirmationRequiredError & { input: unknown }).input).toMatchObject({
      [REPEAT_FLAG]: true,
    });
  });

  it('pasada la ventana, la misma acción vuelve a ejecutarse', async () => {
    const { ctxFor, tables } = setup();
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor());
    const row = tables.action_idempotency?.[0] as Record<string, unknown>;
    row.window_ends_at = new Date(Date.now() - 1000).toISOString();
    await runTool(tool, input, ctxFor());
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('un intento que quedó a medias no se repite solo; a sabiendas, sí', async () => {
    const { ctxFor, tables } = setup();
    const { tool, handler } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor());
    const row = tables.action_idempotency?.[0] as Record<string, unknown>;
    row.status = 'in_flight';
    row.window_ends_at = null;
    row.claimed_at = new Date(Date.now() - 60 * 60_000).toISOString();

    await expect(runTool(tool, input, ctxFor())).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    await runTool(tool, { ...input, [REPEAT_FLAG]: true }, ctxFor());
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('si la tabla no responde, ejecuta igual y la auditoría lo dice', async () => {
    const { ctxFor, tables } = setup();
    const { tool, handler } = sendTool();
    const ctx = ctxFor();
    const scoped = ctx.db;
    ctx.db = {
      ...scoped,
      from: (table: string) => {
        if (table !== 'action_idempotency') return scoped.from(table);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: null,
                error: { message: 'relation does not exist' },
              }),
            }),
          }),
          insert: async () => ({
            data: null,
            error: { code: '42P01', message: 'relation does not exist' },
          }),
        };
      },
    } as unknown as SupabaseClient;
    await expect(runTool(tool, { to: 'a@b.co', body: 'x' }, ctx)).resolves.toMatchObject({
      messageId: expect.any(String),
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const ok = tables.audit_events?.find((r) => r.status === 'ok');
    expect((ok?.metadata as { idempotency: { outcome: string } }).idempotency.outcome).toBe(
      'unguarded',
    );
  });
});

describe('verificar después de actuar', () => {
  it('verificado: queda en la auditoría, en la fila y en lo que lee el modelo', async () => {
    const { ctxFor, tables } = setup();
    const verify = vi.fn(async () => ({
      status: 'verified' as const,
      detail: 'el correo está en Enviados.',
    }));
    const { tool } = sendTool({ verify });
    const out = (await runTool(tool, { to: 'a@b.co', body: 'x' }, ctxFor())) as Record<
      string,
      unknown
    >;
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { to: 'a@b.co', body: 'x' },
        output: expect.objectContaining({ messageId: expect.any(String) }),
      }),
    );
    expect(out._verification).toMatchObject({
      status: 'verified',
      notice: 'Verificado: el correo está en Enviados.',
    });
    const ok = tables.audit_events?.find((r) => r.status === 'ok');
    expect((ok?.metadata as { verification: { status: string } }).verification.status).toBe(
      'verified',
    );
    expect(tables.action_idempotency?.[0]).toMatchObject({
      verification: 'verified',
      verification_detail: 'el correo está en Enviados.',
    });
  });

  it('no verificado: se dice, y se le pide al modelo que lo cuente', async () => {
    const { ctxFor, tables } = setup();
    const { tool } = sendTool({
      verify: async () => ({ status: 'not_verified', detail: 'Gmail no encuentra el mensaje.' }),
    });
    const out = (await runTool(tool, { to: 'a@b.co', body: 'x' }, ctxFor())) as Record<
      string,
      unknown
    >;
    expect(out._verification).toMatchObject({ status: 'not_verified', relayToUser: true });
    expect(tables.action_idempotency?.[0]).toMatchObject({
      status: 'succeeded',
      verification: 'not_verified',
    });
  });

  it('una verificación que revienta es «no se pudo verificar», nunca un fallo de la llamada', async () => {
    const { ctxFor, tables } = setup();
    const { tool } = sendTool({
      verify: async () => {
        throw new Error('timeout');
      },
    });
    const out = (await runTool(tool, { to: 'a@b.co', body: 'x' }, ctxFor())) as Record<
      string,
      unknown
    >;
    expect((out._verification as { status: string }).status).toBe('unverifiable');
    const ok = tables.audit_events?.find((r) => r.status === 'ok');
    expect((ok?.metadata as { verification: { status: string } }).verification.status).toBe(
      'unverifiable',
    );
  });
});

describe('para quien aprueba', () => {
  it('findPriorAction dice cuándo se hizo ya, ignorando el campo de repetir', async () => {
    const { ctxFor, raw } = setup();
    const { tool } = sendTool();
    const input = { to: 'ana@cliente.co', body: 'Hola' };
    await runTool(tool, input, ctxFor());
    const prior = await findPriorAction({
      db: createOrgScopedClient(raw, ORG),
      organizationId: ORG,
      userId: ANA,
      toolId: tool.id,
      input: { ...input, [REPEAT_FLAG]: true },
    });
    expect(prior?.at).toEqual(expect.any(String));
    const none = await findPriorAction({
      db: createOrgScopedClient(raw, ORG),
      organizationId: ORG,
      userId: BEN,
      toolId: tool.id,
      input,
    });
    expect(none).toBeNull();
  });
});

describe('el catálogo', () => {
  it('cada herramienta del catálogo está registrada, con política y con el campo de repetir', () => {
    for (const id of Object.keys(SAFE_ACTION_CATALOG)) {
      const tool = getTool(id);
      expect(tool, id).toBeDefined();
      expect(tool?.safeAction, id).toBeDefined();
      const shape = (tool?.inputSchema as unknown as z.AnyZodObject).shape;
      expect(shape?.[REPEAT_FLAG], id).toBeDefined();
    }
  });

  it('ninguna herramienta de lectura quedó con la guardia por accidente', () => {
    const guarded = listTools()
      .filter((t) => t.safeAction && !t.id.startsWith('test.'))
      .map((t) => t.id);
    expect(guarded.sort()).toEqual(Object.keys(SAFE_ACTION_CATALOG).sort());
  });

  it('trackers.upsert sólo guarda la creación', () => {
    const policy = getTool('trackers.upsert')?.safeAction as { key: (i: unknown) => unknown };
    expect(policy.key({ tracker: 't', values: { a: 1 } })).not.toBeNull();
    expect(policy.key({ tracker: 't', rowId: 'r', values: { a: 1 } })).toBeNull();
  });
});
