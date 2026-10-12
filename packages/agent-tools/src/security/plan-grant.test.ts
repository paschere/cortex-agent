import { ConfirmationRequiredError } from '@cortex/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { normalizePlan } from '../cortex/plan';
import { runTool } from '../registry';
import type { ToolContext, ToolDef } from '../types';
import { resetFrequencyCache } from './frequency';
import {
  type GrantRow,
  PLAN_GRANT_MAX_CALLS,
  PLAN_GRANT_REVOKE_TOOL_ID,
  PLAN_GRANT_TOOL_ID,
  PLAN_GRANT_TTL_MS,
  createPlanGrant,
  neverUnderPlanGrant,
  planGrantCovers,
  resolvePlanGrant,
  revokePlanGrant,
  splitPlanTools,
} from './plan-grant';
import { resetPolicyCache } from './store';

/** audit_events en memoria: lo justo de PostgREST para la concesión. */
type Row = Record<string, unknown>;
function makeCtx(over: { conversationId?: string | undefined; userId?: string } = {}) {
  const audit: Row[] = [];
  let n = 0;
  const builder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let countOnly = false;
    let single = false;
    let pendingInsert: Row | null = null;
    const pick = (r: Row, path: string): unknown => {
      if (path.includes('->>')) {
        const [col, key] = path.split('->>') as [string, string];
        return (r[col] as Row | null)?.[key];
      }
      return r[path];
    };
    const self: Record<string, unknown> = {
      select: (_c?: string, o?: { count?: string; head?: boolean }) => {
        if (o?.head) countOnly = true;
        return self;
      },
      eq: (c: string, v: unknown) => {
        filters.push((r) => pick(r, c) === v);
        return self;
      },
      in: (c: string, v: unknown[]) => {
        filters.push((r) => v.includes(pick(r, c)));
        return self;
      },
      gte: (c: string, v: string) => {
        filters.push((r) => String(pick(r, c)) >= v);
        return self;
      },
      is: () => self,
      lte: () => self,
      gt: () => self,
      lt: () => self,
      contains: () => self,
      order: () => self,
      limit: () => self,
      single: () => {
        single = true;
        return self;
      },
      insert: (row: Row) => {
        if (table === 'audit_events') {
          pendingInsert = { id: `a${++n}`, created_at: new Date().toISOString(), ...row };
          audit.push(pendingInsert);
        }
        return self;
      },
    };
    // biome-ignore lint/suspicious/noThenProperty: imita el builder de PostgREST
    self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
      let result: { data: unknown; count?: number; error: null };
      if (table !== 'audit_events') result = { data: [], error: null };
      else if (pendingInsert) result = { data: single ? pendingInsert : null, error: null };
      else {
        const hit = audit
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        result = countOnly
          ? { data: null, count: hit.length, error: null }
          : { data: hit, error: null };
      }
      return Promise.resolve(result).then(ok, bad);
    };
    return self;
  };
  const ctx = {
    organizationId: 'org',
    userId: over.userId ?? 'u1',
    agentId: 'ag',
    conversationId: 'conversationId' in over ? over.conversationId : 'c1',
    db: { from: (t: string) => builder(t), __audit: audit } as unknown as ToolContext['db'],
    integrations: {
      getAccessToken: vi.fn(),
      hasScopes: vi.fn().mockResolvedValue(true),
    } as unknown as ToolContext['integrations'],
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
  } as ToolContext;
  return { ctx, audit };
}

const handler = vi.fn(async () => ({ ok: true }));
function gated(id: string): ToolDef<Row, { ok: boolean }> {
  return {
    id,
    description: id,
    inputSchema: z.record(z.unknown()),
    outputSchema: z.object({ ok: z.boolean() }),
    requiresConfirmation: true,
    handler,
  };
}
const SAVE = gated('notes.create_note');
const OTHER = gated('notes.update_note');

beforeEach(() => {
  resetPolicyCache();
  resetFrequencyCache();
  handler.mockClear();
});

async function approve(ctx: ToolContext, tools: string[]) {
  return createPlanGrant(ctx.db, {
    conversationId: ctx.conversationId as string,
    userId: ctx.userId,
    tools,
    planCallId: 'call-1',
  });
}

describe('alcance: lo que un plan nunca cubre', () => {
  it('excluye lo no delegable, los envíos, los pagos y los trámites', () => {
    for (const id of [
      'trackers.remove',
      'gmail.send_draft',
      'whatsapp.reply',
      'slack.post_message',
      'browser.submit_flow',
      'payments.approve',
      'sales.invoice_emit',
      'team.invite',
      'gcal.create_event',
      'schedule.create',
    ])
      expect(neverUnderPlanGrant(id), id).toBe(true);
    for (const id of ['trackers.upsert', 'views.create', 'trackers.define', 'browser.open_page'])
      expect(neverUnderPlanGrant(id), id).toBe(false);
  });

  it('reparte las herramientas de un plan en cubiertas, que siempre preguntan y desconocidas', () => {
    const split = splitPlanTools(
      ['trackers.upsert', 'trackers.upsert', 'gmail.send_draft', 'nada.nada'],
      (id) => id !== 'nada.nada',
    );
    expect(split).toEqual({
      grantable: ['trackers.upsert'],
      alwaysAsk: ['gmail.send_draft'],
      unknown: ['nada.nada'],
    });
  });

  it('no crea una concesión cuyo alcance quede vacío', async () => {
    const { ctx } = makeCtx();
    expect(await approve(ctx, ['trackers.remove', 'gmail.send_draft'])).toBeNull();
  });
});

describe('resolvePlanGrant', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const row = (over: Partial<GrantRow> = {}): GrantRow => ({
    id: 'g1',
    tool_id: PLAN_GRANT_TOOL_ID,
    created_at: '2026-10-11T11:50:00Z',
    metadata: { planGrant: { tools: ['trackers.upsert'], ttlMs: PLAN_GRANT_TTL_MS } },
    ...over,
  });

  it('vigente dentro de la ventana; vencida pasada la ventana', () => {
    expect(resolvePlanGrant([row()], now)?.tools).toEqual(['trackers.upsert']);
    expect(resolvePlanGrant([row()], new Date(now.getTime() + 25 * 60_000))).toBeNull();
  });

  it('una fila manipulada no alarga la ventana ni los topes', () => {
    const forged = row({
      metadata: { planGrant: { tools: ['trackers.upsert'], ttlMs: 9e12, maxCalls: 9999 } },
    });
    expect(resolvePlanGrant([forged], new Date(now.getTime() + 60 * 60_000))).toBeNull();
    expect(resolvePlanGrant([forged], now)?.maxCalls).toBe(PLAN_GRANT_MAX_CALLS);
  });

  it('una revocación posterior la apaga; un plan aprobado después la sustituye', () => {
    const revoke = row({
      id: 'r1',
      tool_id: PLAN_GRANT_REVOKE_TOOL_ID,
      created_at: '2026-10-11T11:55:00Z',
      metadata: { grantId: 'g1' },
    });
    expect(resolvePlanGrant([row(), revoke], now)).toBeNull();
    const newer = row({
      id: 'g2',
      created_at: '2026-10-11T11:58:00Z',
      metadata: { planGrant: { tools: ['views.create'] } },
    });
    expect(resolvePlanGrant([row(), revoke, newer], now)?.tools).toEqual(['views.create']);
  });

  it('descarta del alcance cualquier herramienta excluida que se hubiera colado', () => {
    const sneaky = row({
      metadata: { planGrant: { tools: ['trackers.remove', 'gmail.send_draft'] } },
    });
    expect(resolvePlanGrant([sneaky], now)).toBeNull();
  });
});

describe('planGrantCovers', () => {
  const grant = resolvePlanGrant(
    [
      {
        id: 'g',
        tool_id: PLAN_GRANT_TOOL_ID,
        created_at: new Date().toISOString(),
        metadata: { planGrant: { tools: ['trackers.upsert'] } },
      },
    ],
    new Date(),
  );
  it('cubre la herramienta nombrada con riesgo bajo/medio y usos disponibles', () => {
    expect(
      planGrantCovers(grant, { toolId: 'trackers.upsert', riskLevel: 'medium', usedCalls: 0 }),
    ).toBe(true);
  });
  it('no cubre otra herramienta, riesgo alto, ni más allá del tope', () => {
    expect(planGrantCovers(grant, { toolId: 'views.create', riskLevel: 'low', usedCalls: 0 })).toBe(
      false,
    );
    expect(
      planGrantCovers(grant, { toolId: 'trackers.upsert', riskLevel: 'high', usedCalls: 0 }),
    ).toBe(false);
    expect(
      planGrantCovers(grant, {
        toolId: 'trackers.upsert',
        riskLevel: 'low',
        usedCalls: PLAN_GRANT_MAX_CALLS,
      }),
    ).toBe(false);
    expect(
      planGrantCovers(null, { toolId: 'trackers.upsert', riskLevel: 'low', usedCalls: 0 }),
    ).toBe(false);
  });
});

describe('la concesión atravesando runTool', () => {
  it('sin plan aprobado, la herramienta con confirmación sigue pidiéndola', async () => {
    const { ctx } = makeCtx();
    await expect(runTool(SAVE, { title: 'x' }, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('con el plan aprobado ejecuta sin preguntar, anota el uso antes y la auditoría dice delegated', async () => {
    const { ctx, audit } = makeCtx();
    await approve(ctx, ['notes.create_note']);
    await expect(runTool(SAVE, { title: 'x' }, ctx)).resolves.toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const tools = audit.map((r) => r.tool_id);
    expect(tools.indexOf('cortex.plan_grant_use')).toBeGreaterThan(
      tools.indexOf(PLAN_GRANT_TOOL_ID),
    );
    expect(tools.indexOf('cortex.plan_grant_use')).toBeLessThan(tools.indexOf('notes.create_note'));
    const done = audit.filter((r) => r.tool_id === 'notes.create_note').at(-1);
    expect(done?.decision).toBe('delegated');
    expect((done?.metadata as Row).reason).toBe('plan_grant');
    // El riesgo real no se toca.
    expect(['low', 'medium']).toContain(done?.risk_level);
  });

  it('otra herramienta, otra conversación, otro usuario: siguen preguntando', async () => {
    const a = makeCtx();
    await approve(a.ctx, ['notes.create_note']);
    await expect(runTool(OTHER, {}, a.ctx)).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const otherConv = { ...a.ctx, conversationId: 'c2' } as ToolContext;
    await expect(runTool(SAVE, {}, otherConv)).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const otherUser = { ...a.ctx, userId: 'u2' } as ToolContext;
    await expect(runTool(SAVE, {}, otherUser)).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const noConv = { ...a.ctx, conversationId: undefined } as ToolContext;
    await expect(runTool(SAVE, {}, noConv)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('vencida: vuelve a preguntar', async () => {
    const { ctx, audit } = makeCtx();
    await approve(ctx, ['notes.create_note']);
    const g = audit.find((r) => r.tool_id === PLAN_GRANT_TOOL_ID);
    if (g) g.created_at = new Date(Date.now() - PLAN_GRANT_TTL_MS - 60_000).toISOString();
    await expect(runTool(SAVE, {}, ctx)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('agotadas las llamadas, vuelve a preguntar', async () => {
    const { ctx } = makeCtx();
    await approve(ctx, ['notes.create_note']);
    for (let i = 0; i < PLAN_GRANT_MAX_CALLS; i++) await runTool(SAVE, { i }, ctx);
    await expect(runTool(SAVE, { i: 'extra' }, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(handler).toHaveBeenCalledTimes(PLAN_GRANT_MAX_CALLS);
  });

  it('«Detener el plan» la apaga al instante', async () => {
    const { ctx } = makeCtx();
    await approve(ctx, ['notes.create_note']);
    await runTool(SAVE, {}, ctx);
    expect(await revokePlanGrant(ctx.db, { conversationId: 'c1', userId: 'u1' })).toBe(true);
    await expect(runTool(SAVE, {}, ctx)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('una herramienta no delegable pide tarjeta aunque el plan la nombrara', async () => {
    const { ctx, audit } = makeCtx();
    // Se fuerza una fila de concesión que la nombra (ruta manipulada).
    audit.push({
      id: 'forged',
      created_at: new Date().toISOString(),
      user_id: 'u1',
      conversation_id: 'c1',
      tool_id: PLAN_GRANT_TOOL_ID,
      status: 'ok',
      metadata: { planGrant: { tools: ['trackers.remove', 'notes.create_note'] } },
    });
    await expect(runTool(gated('trackers.remove'), {}, ctx)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    await expect(runTool(SAVE, {}, ctx)).resolves.toMatchObject({ ok: true });
  });
});

describe('cortex.plan con herramientas', () => {
  it('conserva tools y what por paso, sin duplicados', () => {
    const out = normalizePlan({
      title: 'Armar',
      steps: [
        {
          id: '1',
          label: 'Crear',
          tools: ['trackers.define', 'trackers.define'],
          what: ' Crea  la tabla ',
        },
        { id: '2', label: 'Leer' },
      ],
    });
    expect(out.steps[0]?.tools).toEqual(['trackers.define']);
    expect(out.steps[0]?.what).toBe('Crea la tabla');
    expect(out.steps[1]?.tools).toBeUndefined();
  });
});
