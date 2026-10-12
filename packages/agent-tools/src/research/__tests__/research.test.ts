import { describe, expect, it, vi } from 'vitest';
import '../../index';
import { getTool, listTools } from '../../registry';
import type { AnyTool, ToolContext } from '../../types';
import {
  RESEARCH_READ_TOOLS,
  ResearchToolRejected,
  assertResearchAllowed,
  isResearchAllowed,
  researchRejection,
  researchToolsFrom,
} from '../allowlist';
import { START_WINDOW_MS, runResearch } from '../index';
import {
  type ItemOutcome,
  type ResearchField,
  buildResult,
  coerceValue,
  gridColumns,
  statusFromValues,
} from '../merge';
import { REPORT_TOOL, buildSubTools, capForModel, execReadOnly, runItem } from '../runner';
import { runPool } from '../scheduler';

const fields: ResearchField[] = [
  { key: 'precio', label: 'Precio', kind: 'money' },
  { key: 'entrega', label: 'Entrega', kind: 'text' },
];

const ALL_IDS = listTools().map((t) => t.id);

function ctxOf(extra: Partial<ToolContext> = {}): ToolContext {
  const db = { from: () => ({ insert: async () => ({ error: null }) }) };
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    agentId: 'a-1',
    db,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    integrations: {},
    grantedToolIds: ALL_IDS,
    ...extra,
  } as unknown as ToolContext;
}

describe('lista blanca de lectura', () => {
  it('rechaza herramientas de escritura, envío y navegador aunque se pidan por id', () => {
    for (const id of [
      'gmail.send_message',
      'gmail.send_draft',
      'browser.act',
      'browser.open_page',
      'ledger.record',
      'payables.approve',
      'accounting.write_purchase',
      'slack.post_message',
      'trackers.upsert',
      'research.parallel',
    ]) {
      const t = getTool(id);
      expect(t, id).toBeDefined();
      expect(isResearchAllowed(t as AnyTool), id).toBe(false);
      expect(() => assertResearchAllowed(t as AnyTool)).toThrow(ResearchToolRejected);
    }
  });

  it('un id de lectura con confirmación, importe o verbo de escritura tampoco pasa', () => {
    const base = { id: 'web.search' } as AnyTool;
    expect(researchRejection(base)).toBeNull();
    expect(researchRejection({ ...base, requiresConfirmation: true } as AnyTool)).toMatch(
      /confirm/,
    );
    expect(
      researchRejection({
        ...base,
        declaredAmount: { amountKey: 'a', currencyKey: 'c' },
      } as AnyTool),
    ).toMatch(/dinero/);
    expect(researchRejection({ ...base, safeAction: {} } as unknown as AnyTool)).toMatch(/efectos/);
    // Cerrojo 4: aunque alguien lo meta a la lista, el verbo lo detiene.
    RESEARCH_READ_TOOLS satisfies ReadonlySet<string>;
    expect(researchRejection({ id: 'web.search' } as AnyTool)).toBeNull();
    expect(researchRejection({ id: 'gmail.send_x' } as AnyTool)).toMatch(/lista/);
  });

  it('todo lo que está en la lista y existe en el registro es realmente de lectura', () => {
    const allowed = researchToolsFrom(listTools(), ALL_IDS);
    expect(allowed.length).toBeGreaterThan(20);
    for (const t of allowed) {
      expect(t.requiresConfirmation).toBeFalsy();
      expect(t.declaredAmount).toBeUndefined();
    }
    // Ninguna herramienta de la lista quedó rechazada por los otros cerrojos.
    const registered = [...RESEARCH_READ_TOOLS].filter((id) => getTool(id));
    const rejected = registered.filter((id) => !isResearchAllowed(getTool(id) as AnyTool));
    expect(rejected).toEqual([]);
  });

  it('una herramienta de la lista que el agente NO tiene concedida se rechaza', async () => {
    const granted = ALL_IDS.filter((id) => id !== 'gmail.search');
    expect(researchToolsFrom(listTools(), granted).map((t) => t.id)).not.toContain('gmail.search');
    expect(researchToolsFrom(listTools(), granted).map((t) => t.id)).toContain('web.search');
    expect(researchToolsFrom(listTools(), undefined)).toEqual([]);

    let seen: string[] = [];
    await runResearch(
      {
        goal: 'prueba de permisos',
        instructions: 'busca algo',
        items: [{ id: 'a', label: 'A' }],
        fields,
      },
      ctxOf({ grantedToolIds: ['web.search'] }),
      {
        generate: (async (a: { tools: Record<string, unknown> }) => {
          seen = Object.keys(a.tools);
          return {
            toolCalls: [],
            text: '',
            usage: { promptTokens: 1, completionTokens: 1 },
            steps: 1,
          };
        }) as never,
      },
    );
    expect(seen.sort()).toEqual(['report_item', 'web_search']);
  });

  it('buildSubTools lanza si le cuelan una de escritura y no la expone', () => {
    const send = getTool('gmail.send_message') as AnyTool;
    expect(() =>
      buildSubTools({ allowed: [send], ctx: ctxOf(), fields, counter: { calls: 0 } }),
    ).toThrow(ResearchToolRejected);
    const tools = buildSubTools({
      allowed: researchToolsFrom(listTools(), ALL_IDS),
      ctx: ctxOf(),
      fields,
      counter: { calls: 0 },
    });
    expect(Object.keys(tools)).toContain(REPORT_TOOL);
    expect(Object.keys(tools)).toContain('web_search');
    expect(Object.keys(tools)).not.toContain('gmail_send_message');
    expect(Object.keys(tools)).not.toContain('browser_act');
  });

  it('execReadOnly no ejecuta una de escritura (ni cuenta la llamada)', async () => {
    const handler = vi.fn(async () => ({ sent: true }));
    const fake = { ...(getTool('gmail.send_message') as AnyTool), handler } as AnyTool;
    const counter = { calls: 0 };
    await expect(execReadOnly(fake, {}, ctxOf(), counter)).rejects.toThrow(ResearchToolRejected);
    expect(handler).not.toHaveBeenCalled();
    expect(counter.calls).toBe(0);
  });
});

describe('repartidor', () => {
  it('nunca pasa del límite de concurrencia y conserva el orden', async () => {
    let live = 0;
    let peak = 0;
    const res = await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      async (n) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 3));
        live--;
        return n * 2;
      },
      { concurrency: 6 },
    );
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
    expect(res.settled.map((s) => s.value)).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(res.notStarted).toEqual([]);
    expect(res.stopReason).toBeNull();
  });

  it('al pararse deja las que no empezaron y termina las que corrían', async () => {
    let started = 0;
    const res = await runPool(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        started++;
        await new Promise((r) => setTimeout(r, 2));
      },
      { concurrency: 3, shouldStop: () => (started >= 4 ? 'tiempo' : null) },
    );
    expect(res.stopReason).toBe('tiempo');
    expect(res.settled.length).toBe(started);
    expect(res.settled.length + res.notStarted.length).toBe(10);
    expect(res.notStarted[0]).toBe(res.settled.length);
  });

  it('un trabajador que lanza no tumba a los demás', async () => {
    const res = await runPool(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      },
      { concurrency: 2 },
    );
    expect(res.settled.map((s) => s.ok)).toEqual([true, false, true]);
  });
});

describe('unir resultados', () => {
  const ok = (values: Record<string, unknown>, extra: Partial<ItemOutcome> = {}): ItemOutcome => ({
    status: 'Listo',
    values,
    notes: 'nota',
    sources: ['https://a.co', 'https://a.co'],
    promptTokens: 100,
    completionTokens: 20,
    steps: 2,
    toolCalls: 1,
    ms: 5,
    ...extra,
  });

  it('normaliza valores y calcula el estado por fila', () => {
    expect(coerceValue('money', '1200')).toBe(1200);
    expect(coerceValue('money', '1.234,5')).toBe('1.234,5');
    expect(coerceValue('text', 'N/A')).toBeNull();
    expect(statusFromValues({ a: 1, b: null })).toBe('Parcial');
    expect(statusFromValues({ a: null })).toBe('Sin dato');
    expect(statusFromValues({ a: 1 })).toBe('Listo');
  });

  it('arma columnas, filas, totales y «faltan N»', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() }));
    const res = buildResult({
      goal: 'g',
      fields,
      items,
      done: [
        {
          item: items[0] as (typeof items)[number],
          outcome: ok({ precio: '10', entrega: '3 días' }),
        },
        { item: items[1] as (typeof items)[number], outcome: ok({ precio: null, entrega: null }) },
        {
          item: items[2] as (typeof items)[number],
          outcome: {
            ...ok({}),
            status: 'Error',
            error: 'se cayó',
            promptTokens: 0,
            completionTokens: 0,
          },
        },
      ],
      notStarted: [items[3] as (typeof items)[number]],
      stopReason: 'tiempo',
      model: 'fast',
      elapsedMs: 10,
    });
    expect(res.rows.map((r) => r.status)).toEqual(['Listo', 'Sin dato', 'Error']);
    expect(res.rows[0]?.values.precio).toBe(10);
    expect(res.rows[0]?.sources).toBe('https://a.co');
    expect(res.rows[2]?.notes).toBe('se cayó');
    expect(res.counts).toMatchObject({
      requested: 4,
      processed: 3,
      complete: 1,
      noData: 1,
      error: 1,
    });
    expect(res.remaining).toBe(1);
    expect(res.pending).toEqual([{ id: 'd', label: 'D' }]);
    expect(res.runInBackground).toBe(true);
    expect(res.stopReason).toBe('tiempo');
    expect(res.summary).toMatch(/Faltan 1/);
    expect(res.usage).toMatchObject({
      promptTokens: 200,
      completionTokens: 40,
      totalTokens: 240,
      subRuns: 3,
    });
    expect(res.columns.map((c) => c.key)).toEqual([
      'label',
      'values.precio',
      'values.entrega',
      'status',
      'notes',
    ]);
    expect(gridColumns(fields)[1]?.kind).toBe('money');
  });

  it('sin pendientes no hay bandera ni motivo', () => {
    const items = [{ id: 'a', label: 'A' }];
    const res = buildResult({
      goal: 'g',
      fields,
      items,
      done: [
        { item: items[0] as (typeof items)[number], outcome: ok({ precio: 1, entrega: 'x' }) },
      ],
      notStarted: [],
      stopReason: null,
      model: 'fast',
      elapsedMs: 1,
    });
    expect(res.remaining).toBe(0);
    expect(res.runInBackground).toBe(false);
    expect(res.stopReason).toBeNull();
    expect(res.summary).not.toMatch(/Faltan/);
  });

  it('capForModel recorta lo grande', () => {
    expect(capForModel({ a: 1 })).toEqual({ a: 1 });
    const big = capForModel({ t: 'x'.repeat(10_000) }) as { __truncated: boolean; preview: string };
    expect(big.__truncated).toBe(true);
    expect(big.preview.length).toBe(6000);
  });
});

describe('research.parallel de punta a punta (generador falso)', () => {
  const report = (n: number) => ({
    toolCalls: [
      {
        toolName: REPORT_TOOL,
        args: { values: { precio: n, entrega: 'mañana' }, notes: 'ok', sources: ['https://x.co'] },
      },
    ],
    text: '',
    usage: { promptTokens: 1000, completionTokens: 100 },
    steps: 2,
  });
  const input = (n: number, extra = {}) => ({
    goal: 'comparar proveedores',
    instructions: 'busca precio y entrega',
    items: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `Proveedor ${i}` })),
    fields,
    model: 'fast' as const,
    maxStepsPerItem: 5,
    concurrency: 6,
    ...extra,
  });

  it('procesa todo, respeta la concurrencia y las piezas sólo ven herramientas de lectura', async () => {
    let live = 0;
    let peak = 0;
    let seenTools: string[] = [];
    const generate = vi.fn(async (a: { tools: Record<string, unknown> }) => {
      seenTools = Object.keys(a.tools);
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return report(5);
    });
    const progress: string[] = [];
    const res = await runResearch(input(15), ctxOf({ onProgress: (l) => progress.push(l) }), {
      generate: generate as never,
    });
    expect(res.counts).toMatchObject({ requested: 15, processed: 15, complete: 15 });
    expect(res.remaining).toBe(0);
    expect(peak).toBeLessThanOrEqual(6);
    expect(seenTools).toContain('web_search');
    expect(seenTools.some((t) => /_send_|browser_|ledger_record|approve|upsert/.test(t))).toBe(
      false,
    );
    expect(res.usage.totalTokens).toBe(15 * 1100);
    expect(progress.at(-1)).toMatch(/15 de 15/);
  });

  it('devuelve parcial con «faltan N» cuando al turno le queda poco', async () => {
    let left = 200_000;
    const generate = vi.fn(async () => {
      left -= 60_000; // cada pieza se come un buen trozo del turno
      return report(1);
    });
    const res = await runResearch(
      input(10, { concurrency: 1 }),
      ctxOf({ turnMsLeft: () => left }),
      { generate: generate as never },
    );
    expect(res.stopReason).toBe('tiempo');
    expect(res.counts.processed).toBeGreaterThan(0);
    expect(res.counts.processed).toBeLessThan(10);
    expect(res.remaining).toBe(10 - res.counts.processed);
    expect(res.pending).toHaveLength(res.remaining);
    expect(res.pending[0]?.id).toBe(`p${res.counts.processed}`);
    expect(res.runInBackground).toBe(true);
  });

  it('para por presupuesto de tokens', async () => {
    const generate = vi.fn(async () => ({
      ...report(1),
      usage: { promptTokens: 100_000, completionTokens: 0 },
    }));
    const res = await runResearch(input(5, { concurrency: 1 }), ctxOf(), {
      generate: generate as never,
    });
    expect(res.stopReason).toBe('presupuesto');
    expect(res.counts.processed).toBeLessThan(5);
  });

  it('una pieza que falla es una fila Error; sin ficha es Parcial', async () => {
    let n = 0;
    const generate = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('modelo caído');
      if (n === 2)
        return {
          toolCalls: [],
          text: 'no alcancé',
          usage: { promptTokens: 1, completionTokens: 1 },
          steps: 5,
        };
      return report(3);
    });
    const res = await runResearch(input(3, { concurrency: 1 }), ctxOf(), {
      generate: generate as never,
    });
    expect(res.rows.map((r) => r.status)).toEqual(['Error', 'Parcial', 'Listo']);
    expect(res.rows[0]?.notes).toMatch(/modelo caído/);
  });

  it('rechaza ids repetidos y no escribe auditoría de más', async () => {
    await expect(
      runResearch(
        {
          ...input(2),
          items: [
            { id: 'x', label: 'a' },
            { id: 'x', label: 'b' },
          ],
        },
        ctxOf(),
        { generate: (async () => report(1)) as never },
      ),
    ).rejects.toThrow(/Id repetido/);
  });

  it('escribe una fila de auditoría por pieza', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const ctx = ctxOf({ db: { from: () => ({ insert }) } as never });
    await runResearch(input(4), ctx, { generate: (async () => report(1)) as never });
    expect(insert).toHaveBeenCalledTimes(4);
    expect((insert.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      tool_id: 'research.item',
      user_id: 'u-1',
    });
  });

  it('constantes coherentes con el reloj del turno', () => {
    expect(START_WINDOW_MS).toBeLessThan(180_000);
  });
});

describe('runItem', () => {
  it('un tiempo agotado deja la fila en Error', async () => {
    const out = await runItem({
      item: { id: 'a', label: 'A' },
      goal: 'g',
      instructions: 'i',
      fields,
      allowed: [],
      ctx: ctxOf(),
      generate: (a) =>
        new Promise((_, reject) =>
          a.abortSignal.addEventListener('abort', () => reject(new Error('abortada'))),
        ),
      maxSteps: 3,
      timeoutMs: 1_000,
    });
    expect(out.status).toBe('Error');
    expect(out.error).toMatch(/tiempo/);
  }, 5_000);
});
