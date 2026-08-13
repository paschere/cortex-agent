import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runTool } from '../registry';
import type { ToolContext, ToolDef } from '../types';
import { resetFrequencyCache } from './frequency';
import { resetPolicyCache } from './store';

/**
 * El mandato ATRAVESANDO runTool, que es donde se decide de verdad.
 *
 * `mandate.test.ts` prueba la función pura. Esto prueba las dos puertas reales:
 * la de seguridad y la que la herramienta se puso a sí misma
 * (`requiresConfirmation`), y que la lectura caída se cae a preguntar en vez de
 * a actuar.
 */

const INTERNAL = 'acme.test';

interface Row {
  [k: string]: unknown;
}

interface StubOpts {
  /** Filas de `mandates` que la base devuelve. */
  mandates?: Row[];
  /** Filas de `mandate_uses` de hoy. */
  uses?: Row[];
  /** La lectura de mandatos falla. */
  mandatesDown?: boolean;
  /** La anotación del uso falla. */
  useInsertFails?: boolean;
}

/**
 * Un cliente falso encadenable. Toda llamada de filtro devuelve el mismo objeto
 * y el objeto es `then`-able, que es exactamente cómo se comporta PostgREST.
 */
function makeCtx(opts: StubOpts = {}): ToolContext {
  const inserts: { table: string; row: Row }[] = [];

  const builder = (table: string, result: () => { data: unknown; error: unknown }) => {
    const self: Record<string, unknown> = {};
    for (const m of [
      'select',
      'is',
      'lte',
      'gt',
      'gte',
      'lt',
      'in',
      'contains',
      'eq',
      'order',
      'limit',
    ]) {
      self[m] = () => self;
    }
    self.insert = (row: Row) => {
      inserts.push({ table, row });
      const failed = table === 'mandate_uses' && opts.useInsertFails === true;
      return Promise.resolve({ data: null, error: failed ? { message: 'insert down' } : null });
    };
    // Un `then` propio es exactamente lo que hace PostgrestBuilder: la cadena
    // se espera con `await` sin llamar a ningún `.execute()`. Sin él, el doble
    // no se parecería a la cosa que dobla.
    // biome-ignore lint/suspicious/noThenProperty: imita el builder de PostgREST
    self.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled, onRejected);
    return self;
  };

  const db = {
    from: (table: string) => {
      if (table === 'mandates') {
        return builder(table, () =>
          opts.mandatesDown
            ? { data: null, error: { message: 'mandates unreachable' } }
            : { data: opts.mandates ?? [], error: null },
        );
      }
      if (table === 'mandate_uses') {
        return builder(table, () => ({ data: opts.uses ?? [], error: null }));
      }
      return builder(table, () => ({ data: null, error: null }));
    },
    __inserts: inserts,
  };

  return {
    organizationId: 'org-test',
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as ToolContext['logger'],
  };
}

function rows(ctx: ToolContext, table: string): Row[] {
  return (ctx.db as unknown as { __inserts: { table: string; row: Row }[] }).__inserts
    .filter((i) => i.table === table)
    .map((i) => i.row);
}

function insertOrder(ctx: ToolContext): string[] {
  return (ctx.db as unknown as { __inserts: { table: string }[] }).__inserts.map((i) => i.table);
}

const handler = vi.fn(async () => ({ ok: true }));

function mailTool(
  extra: Partial<ToolDef<Row, { ok: boolean }>> = {},
): ToolDef<Row, { ok: boolean }> {
  return {
    id: 'gmail.send_draft',
    description: 'send',
    inputSchema: z.record(z.unknown()),
    outputSchema: z.object({ ok: z.boolean() }),
    // La puerta propia de la herramienta, igual que la de verdad.
    requiresConfirmation: true,
    handler,
    ...extra,
  };
}

/** Una fila de `mandates` tal y como la devuelve la base. */
function mandateRow(over: Row = {}): Row {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    label: 'Correos a clientes',
    tool_patterns: ['gmail.*'],
    covered_tool_ids: ['gmail.send_draft', 'gmail.draft'],
    max_risk_level: 'high',
    amount_ceiling: null,
    currency: null,
    applies_unattended: false,
    max_uses_per_day: null,
    ...over,
  };
}

const CLIENT_MAIL = { to: 'cfo@cliente.example', body: 'Adjunto la propuesta que hablamos.' };

beforeEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = INTERNAL;
  resetPolicyCache();
  resetFrequencyCache();
  handler.mockClear();
});

afterEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = '';
});

describe('el mandato atravesando runTool', () => {
  it('sin mandato, un correo a un cliente sigue parándose', async () => {
    const ctx = makeCtx();
    await expect(runTool(mailTool(), CLIENT_MAIL, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('con mandato, sale sin preguntar y queda como `delegated`', async () => {
    const ctx = makeCtx({ mandates: [mandateRow()] });
    const out = await runTool(mailTool(), CLIENT_MAIL, ctx);
    expect(out).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);

    const audit = rows(ctx, 'audit_events').at(-1);
    expect(audit?.decision).toBe('delegated');
    // El nivel REAL de la llamada, no el techo del mandato.
    expect(audit?.risk_level).toBe('high');
    expect(audit?.mandate_id).toBe('aaaaaaaa-0000-0000-0000-000000000001');

    const event = rows(ctx, 'security_events').at(-1);
    expect(event?.decision).toBe('delegated');
    expect(event?.mandate_id).toBe('aaaaaaaa-0000-0000-0000-000000000001');
  });

  it('el uso se anota ANTES de ejecutar', async () => {
    const ctx = makeCtx({ mandates: [mandateRow()] });
    await runTool(mailTool(), CLIENT_MAIL, ctx);

    const order = insertOrder(ctx);
    const use = order.indexOf('mandate_uses');
    // La única escritura posterior es la fila de auditoría del resultado, que
    // solo existe si la herramienta llegó a correr.
    expect(use).toBeGreaterThanOrEqual(0);
    expect(order.slice(use + 1)).toContain('audit_events');

    const row = rows(ctx, 'mandate_uses').at(0);
    expect(row?.tool_id).toBe('gmail.send_draft');
    expect(row?.risk_level).toBe('high');
    expect(row?.surface).toBe('web');
  });

  it('si el uso no se puede anotar, no hay delegación', async () => {
    const ctx = makeCtx({ mandates: [mandateRow()], useInsertFails: true });
    await expect(runTool(mailTool(), CLIENT_MAIL, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('con la lectura de mandatos caída, todo se cae a confirmar', async () => {
    const ctx = makeCtx({ mandates: [mandateRow()], mandatesDown: true });
    await expect(runTool(mailTool(), CLIENT_MAIL, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('levanta también la puerta propia de la herramienta sobre un correo interno', async () => {
    const internal = { to: `jefe@${INTERNAL}`, body: 'el acta de ayer' };

    const withoutMandate = makeCtx();
    await expect(runTool(mailTool(), internal, withoutMandate)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );

    const withMandate = makeCtx({ mandates: [mandateRow()] });
    await expect(runTool(mailTool(), internal, withMandate)).resolves.toMatchObject({ ok: true });
  });

  it('un critical sigue siendo indelegable con el mandato más amplio posible', async () => {
    const ctx = makeCtx({
      mandates: [mandateRow({ tool_patterns: ['gmail.*'], applies_unattended: true })],
    });
    await expect(
      runTool(mailTool(), { to: 'cfo@cliente.example', body: 'salary breakdown adjunto' }, ctx),
    ).rejects.toBeInstanceOf(SecurityBlockedError);
    expect(handler).not.toHaveBeenCalled();
    // Y no se anotó ningún uso: no hubo delegación que anotar.
    expect(rows(ctx, 'mandate_uses')).toHaveLength(0);
    expect(rows(ctx, 'security_events').at(-1)?.decision).toBe('blocked');
  });

  it('la instantánea manda: una herramienta fuera de ella no se delega', async () => {
    const ctx = makeCtx({ mandates: [mandateRow({ covered_tool_ids: ['gmail.draft'] })] });
    await expect(runTool(mailTool(), CLIENT_MAIL, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it('el presupuesto del día se agota', async () => {
    const spent = makeCtx({
      mandates: [mandateRow({ max_uses_per_day: 2 })],
      uses: [
        { mandate_id: 'aaaaaaaa-0000-0000-0000-000000000001' },
        { mandate_id: 'aaaaaaaa-0000-0000-0000-000000000001' },
      ],
    });
    await expect(runTool(mailTool(), CLIENT_MAIL, spent)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );

    const left = makeCtx({
      mandates: [mandateRow({ max_uses_per_day: 2 })],
      uses: [{ mandate_id: 'aaaaaaaa-0000-0000-0000-000000000001' }],
    });
    await expect(runTool(mailTool(), CLIENT_MAIL, left)).resolves.toMatchObject({ ok: true });
  });

  it('una fila con techo sin moneda se descarta entera', async () => {
    const ctx = makeCtx({ mandates: [mandateRow({ amount_ceiling: 500_000, currency: null })] });
    await expect(runTool(mailTool(), CLIENT_MAIL, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it('un techo monetario sobre una herramienta que declara importe sí muerde', async () => {
    const payTool: ToolDef<Row, { ok: boolean }> = {
      id: 'payments.approve',
      description: 'approve',
      inputSchema: z.record(z.unknown()),
      outputSchema: z.object({ ok: z.boolean() }),
      requiresConfirmation: true,
      declaredAmount: { amountKey: 'amount', currencyKey: 'currency' },
      handler,
    };
    const grant = mandateRow({
      tool_patterns: ['payments.*'],
      covered_tool_ids: ['payments.approve'],
      amount_ceiling: 500_000,
      currency: 'COP',
    });

    const under = makeCtx({ mandates: [grant] });
    await expect(
      runTool(payTool, { amount: 400_000, currency: 'COP' }, under),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(rows(under, 'mandate_uses').at(0)).toMatchObject({ amount: 400_000, currency: 'COP' });

    const over = makeCtx({ mandates: [grant] });
    await expect(
      runTool(payTool, { amount: 600_000, currency: 'COP' }, over),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const wrongCurrency = makeCtx({ mandates: [grant] });
    await expect(
      runTool(payTool, { amount: 100, currency: 'USD' }, wrongCurrency),
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });
});
