import { NoSuchToolError, generateText, jsonSchema, tool } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DISPATCH_TOOL_NAME, resolveDispatch, withNoSuchToolRedirect } from './tool-dispatch';

const allowed = [
  { id: 'trackers.propose_from_source', kind: 'registry' },
  { id: 'trackers.list', kind: 'registry' },
  { id: 'mcp:x:y', kind: 'external' },
];

describe('resolveDispatch', () => {
  it('acepta el nombre con guion bajo o con punto', () => {
    expect(resolveDispatch('trackers_propose_from_source', allowed).ok).toBe(true);
    expect(resolveDispatch('trackers.list', allowed).ok).toBe(true);
  });
  it('rechaza lo no permitido con un mensaje que sugiere alternativas', () => {
    const r = resolveDispatch('trackers_delete_all', allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('trackers_list');
  });
  it('no despacha herramientas externas', () => {
    expect(resolveDispatch('mcp:x:y', allowed).ok).toBe(false);
  });
});

/** Un modelo que llama a una herramienta que no está declarada. */
function modelCalling(toolName: string) {
  let step = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => {
      step++;
      return step === 1
        ? {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: 'tool-calls' as const,
            usage: { promptTokens: 1, completionTokens: 1 },
            toolCalls: [
              { toolCallType: 'function' as const, toolCallId: 'c1', toolName, args: '{"a":1}' },
            ],
          }
        : {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1 },
            text: 'listo',
          };
    },
  });
}

describe('NoSuchToolError no tumba el turno', () => {
  const base = async () => null;

  function run(toolName: string, requiresConfirmation = false) {
    const calls: unknown[] = [];
    const tools = {
      [DISPATCH_TOOL_NAME]: tool({
        parameters: z.object({ tool: z.string(), args: z.record(z.unknown()).default({}) }),
        execute: async ({ tool: name, args }) => {
          const r = resolveDispatch(name, allowed);
          if (!r.ok) return { __error: true, message: r.message };
          if (requiresConfirmation)
            return { __requires_confirmation: true, toolId: r.candidate.id, input: args };
          calls.push([r.candidate.id, args]);
          return { ok: true };
        },
      }),
    };
    return generateText({
      model: modelCalling(toolName),
      tools,
      maxSteps: 3,
      prompt: 'x',
      experimental_repairToolCall: withNoSuchToolRedirect(base),
    }).then((r) => ({ r, calls }));
  }

  it('una herramienta permitida se ejecuta por el despachador', async () => {
    const { r, calls } = await run('trackers_propose_from_source');
    expect(r.text).toBe('listo');
    expect(calls).toEqual([['trackers.propose_from_source', { a: 1 }]]);
  });
  it('respeta la confirmación: devuelve el centinela, no ejecuta', async () => {
    const { r, calls } = await run('trackers_propose_from_source', true);
    expect(calls).toEqual([]);
    const result = r.steps[0]?.toolResults[0]?.result as { __requires_confirmation?: boolean };
    expect(result.__requires_confirmation).toBe(true);
  });
  it('una no permitida devuelve error al modelo y el turno sigue', async () => {
    const { r, calls } = await run('payroll_pay_everyone');
    expect(calls).toEqual([]);
    expect(r.text).toBe('listo');
    const result = r.steps[0]?.toolResults[0]?.result as { __error?: boolean };
    expect(result.__error).toBe(true);
  });
  it('sin despachador declarado, no repara (el SDK lanza como antes)', async () => {
    const fn = withNoSuchToolRedirect(base);
    const out = await fn({
      toolCall: { toolCallType: 'function', toolCallId: 'c', toolName: 'x', args: '{}' },
      tools: {},
      error: new NoSuchToolError({ toolName: 'x', availableTools: [] }),
      parameterSchema: () => jsonSchema({}).jsonSchema,
      system: undefined,
      messages: [],
    } as never);
    expect(out).toBeNull();
  });
});
