import {
  ConfirmationRequiredError,
  RateLimitError,
  SecurityBlockedError,
  ValidationError,
} from '@cortex/core';
import { writeAuditEvent } from './audit.js';
import { consumeToken } from './rate-limit.js';
import {
  evaluate as evaluateSecurity,
  explainBlock,
  explainFlag,
  isIncident,
  riskAuditFields,
  writeSecurityEvent,
} from './security/enforce.js';
import type { AnyTool, ToolContext, ToolDef } from './types.js';

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
  // A bare '*' means every family, including ones that do not exist yet. An
  // agent listing families one by one silently loses access to each new
  // integration until somebody remembers to add it — a whole family has
  // shipped, deployed and stayed invisible for a day that way. '*' is the
  // grant that keeps meaning what it said. Narrowing still happens where it
  // belongs: team deny-lists and the security gate both run downstream of this.
  if (pat === '*') return !id.startsWith('test.');
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

  // ---------------------------------------------------------------------------
  // Security enforcement.
  //
  // runTool is the ONE choke point every tool call passes through — web chat,
  // MCP/Claude, scheduled jobs. So classification, logging and blocking happen
  // here, deterministically, on every call. It must never depend on the model
  // deciding to consult a "check me" tool, because a model can simply skip that.
  //
  // Cost: at most one round-trip of latency (policy + frequency run in
  // parallel, both memoised 60s); zero for a low-risk call with warm caches.
  // ---------------------------------------------------------------------------
  const evaluation = await evaluateSecurity({
    tool,
    input: parsed.data,
    db: ctx.db,
    userId: ctx.userId,
    surface: ctx.surface,
    confirmed: opts.confirmed,
  });
  const risk = riskAuditFields(evaluation);
  const securityEventBase = {
    db: ctx.db,
    userId: ctx.userId,
    agentId: ctx.agentId,
    toolId: tool.id,
    input: parsed.data,
    evaluation,
  };

  if (evaluation.decision === 'block') {
    await Promise.all([
      writeSecurityEvent({ ...securityEventBase, decision: 'blocked' }),
      writeAuditEvent({
        db: ctx.db,
        userId: ctx.userId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        toolId: tool.id,
        input,
        status: 'error',
        latencyMs: Math.round(performance.now() - t0),
        metadata: { reason: 'security_blocked' },
        ...risk,
      }),
    ]);
    throw new SecurityBlockedError(
      explainBlock(evaluation.classification),
      tool.id,
      evaluation.classification.riskLevel,
      evaluation.classification.signals,
    );
  }

  // A high-risk call is gated even when the tool itself never declared
  // requiresConfirmation — the risk lives in the data and the destination,
  // not in the tool definition.
  if (evaluation.decision === 'confirm' && !opts.confirmed) {
    await Promise.all([
      writeSecurityEvent({ ...securityEventBase, decision: 'confirm_required' }),
      writeAuditEvent({
        db: ctx.db,
        userId: ctx.userId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        toolId: tool.id,
        input,
        status: 'confirmation_required',
        latencyMs: Math.round(performance.now() - t0),
        ...risk,
      }),
    ]);
    throw new ConfirmationRequiredError(tool.id, parsed.data);
  }

  // Anything above low risk that is going to proceed still leaves an incident
  // row, so the audit UI can show what the guardrails saw and let through.
  if (isIncident(evaluation)) {
    await writeSecurityEvent({
      ...securityEventBase,
      decision: opts.confirmed && evaluation.decision === 'confirm' ? 'confirmed' : 'flagged',
    });
  }

  // Decision recorded on every row written from here on: a gated call that the
  // user approved is 'confirmed', everything else keeps its natural decision.
  const riskFinal = riskAuditFields(
    evaluation,
    opts.confirmed && evaluation.decision === 'confirm' ? 'confirmed' : undefined,
  );

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
      ...risk,
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
          ...riskFinal,
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
          ...riskFinal,
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
      ...riskFinal,
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
      ...riskFinal,
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
    ...riskFinal,
  });

  // A flag nobody sees is not a guardrail. High/medium-risk calls succeed, but
  // the reason travels back WITH the result so the model can tell the user
  // what just happened ("this pulled compensation for 190 people; it's logged").
  // Attached out-of-band on the returned object: the tool's declared output
  // schema is already validated above, so this never breaks a contract, and
  // consumers that don't know about it simply ignore the extra key.
  if (isIncident(evaluation) && outParsed.data && typeof outParsed.data === 'object') {
    Object.defineProperty(outParsed.data, '_security', {
      value: {
        riskLevel: evaluation.classification.riskLevel,
        notice: explainFlag(evaluation.classification),
        signals: evaluation.classification.signals,
        // Instruction to the model, not text to echo verbatim.
        relayToUser: true,
      },
      // MUST stay enumerable: MCP and the web chat serialize tool results with
      // JSON.stringify, and a non-enumerable key would never reach the model.
      enumerable: true,
      writable: false,
    });
  }

  return outParsed.data;
}
