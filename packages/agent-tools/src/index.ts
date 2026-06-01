import { ConfirmationRequiredError, RateLimitError, ValidationError } from '@zipdev/core';
import { writeAuditEvent } from './audit';
import { consumeToken } from './rate-limit';
import type { AnyTool, ToolContext, ToolDef } from './types';

const REGISTRY = new Map<string, AnyTool>();

export function registerTool<I, O>(tool: ToolDef<I, O>): ToolDef<I, O> {
  REGISTRY.set(tool.id, tool as unknown as AnyTool);
  return tool;
}

export function getTool(id: string): AnyTool | undefined {
  return REGISTRY.get(id);
}
export function listTools(): AnyTool[] {
  return [...REGISTRY.values()];
}

export function filterTools(allowed: string[]): AnyTool[] {
  return [...REGISTRY.values()].filter((t) => allowed.some((pat) => matchPattern(pat, t.id)));
}

function matchPattern(pat: string, id: string): boolean {
  if (pat.endsWith('.*')) return id.startsWith(pat.slice(0, -1));
  return pat === id;
}

export async function runTool<I, O>(
  tool: ToolDef<I, O>,
  input: unknown,
  ctx: ToolContext,
  opts: { confirmed?: boolean } = {},
): Promise<O> {
  const t0 = performance.now();
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'error',
      latencyMs: Math.round(performance.now() - t0),
      metadata: { reason: 'validation', issues: parsed.error.flatten() },
    });
    throw new ValidationError(`Invalid input for ${tool.id}`, parsed.error.flatten());
  }
  if (tool.requiresConfirmation && !opts.confirmed) {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'confirmation_required',
      latencyMs: Math.round(performance.now() - t0),
    });
    throw new ConfirmationRequiredError(tool.id, parsed.data);
  }
  if (tool.rateLimit) {
    try {
      await consumeToken(ctx.db, ctx.userId, tool.id, tool.rateLimit.perMinute);
    } catch (err) {
      if (err instanceof RateLimitError) {
        await writeAuditEvent({
          db: ctx.db,
          userId: ctx.userId,
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
          toolId: tool.id,
          input,
          status: 'rate_limited',
          latencyMs: Math.round(performance.now() - t0),
        });
      }
      throw err;
    }
  }
  if (tool.requiredScopes) {
    for (const r of tool.requiredScopes) {
      const ok = await ctx.integrations.hasScopes(r.provider, r.scopes);
      if (!ok) {
        await writeAuditEvent({
          db: ctx.db,
          userId: ctx.userId,
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
          toolId: tool.id,
          input,
          status: 'error',
          latencyMs: Math.round(performance.now() - t0),
          metadata: { reason: 'missing_scopes', provider: r.provider, scopes: r.scopes },
        });
        throw new ValidationError(`Missing ${r.provider} scopes: ${r.scopes.join(',')}`);
      }
    }
  }
  let result: O;
  try {
    const exec = () => tool.handler(parsed.data, ctx) as Promise<O>;
    result = ctx.withSpan
      ? await ctx.withSpan(`tool.${tool.id}`, { 'tool.id': tool.id, 'user.id': ctx.userId }, exec)
      : await exec();
  } catch (err) {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'error',
      latencyMs: Math.round(performance.now() - t0),
      metadata: { error: (err as Error).message },
    });
    throw err;
  }

  const outParsed = tool.outputSchema.safeParse(result);
  if (!outParsed.success) {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'error',
      latencyMs: Math.round(performance.now() - t0),
      metadata: { reason: 'output_validation' },
    });
    throw new ValidationError(`Invalid output from ${tool.id}`);
  }

  await writeAuditEvent({
    db: ctx.db,
    userId: ctx.userId,
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
    toolId: tool.id,
    input,
    status: 'ok',
    latencyMs: Math.round(performance.now() - t0),
  });
  return outParsed.data;
}

export * from './types';
export { writeAuditEvent } from './audit';
export { consumeToken } from './rate-limit';
export { createIntegrationsClient } from './integrations';
export * from './rate';
export * from './gmail';
export * from './gcal';
export * from './gsheets';
export * from './hubspot';
export * from './kb';
export * from './gdrive';
export * from './web';
