import {
  ConfirmationRequiredError,
  RateLimitError,
  SecurityBlockedError,
  ValidationError,
} from '@cortex/core';
import { hashInput, writeAuditEvent } from './audit.js';
import { consumeToken } from './rate-limit.js';
import { hasConversationGrace } from './security/conversation-grace.js';
import {
  evaluate as evaluateSecurity,
  explainBlock,
  explainFlag,
  isIncident,
  riskAuditFields,
  writeSecurityEvent,
} from './security/enforce.js';
import { recordMandateUse } from './security/mandate-store.js';
import { explainDelegation, typedAmount } from './security/mandate.js';
import { toolErrorMessage } from './tool-error.js';
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

/**
 * Does an agent's grant cover this tool id?
 *
 * Exported because not every tool a turn can offer lives in the registry:
 * custom tools (migration 0067) are built per request from the workspace's own
 * rows, and they have to be gated by the SAME grant patterns as everything
 * else. Without this they would either be ungated — a grant of `kb.*` would
 * still hand the model every custom tool — or would need a second, parallel
 * notion of "allowed", which is how two access rules drift apart.
 */
export function toolIdAllowed(patterns: string[], id: string): boolean {
  return patterns.some((pat) => matchPattern(pat, id));
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

  // ---------------------------------------------------------------------------
  // NADA PASA POR AQUÍ. Ni `opts.confirmed`, ni una rutina desatendida, ni un
  // mandato: esta rama se evalúa ANTES que ninguna de las tres y no consulta a
  // ninguna. `applyMandate()` (migración 0099) devuelve `block` cuando le entra
  // `block`, sin condiciones, así que la delegación no puede llegar hasta aquí
  // — y si algún día alguien le añade una excepción a aquella función, esta
  // rama sigue sin preguntarle nada a nadie. Esa redundancia es intencionada.
  // ---------------------------------------------------------------------------
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
      decision: evaluation.mandate
        ? 'delegated'
        : opts.confirmed && evaluation.decision === 'confirm'
          ? 'confirmed'
          : 'flagged',
    });
  }

  // Decision recorded on every row written from here on: a gated call that the
  // user approved is 'confirmed', everything else keeps its natural decision
  // ('delegated' incluido, que lo pone riskAuditFields al ver la concesión).
  const riskFinal = riskAuditFields(
    evaluation,
    opts.confirmed && evaluation.decision === 'confirm' ? 'confirmed' : undefined,
  );

  // ---------------------------------------------------------------------------
  // EL USO SE ANOTA ANTES DE EJECUTAR.
  //
  // Y si no se puede anotar, no hay delegación. Sin rastro no hay autonomía: una
  // acción que Cortex hizo por su cuenta y de la que no queda constancia es
  // indistinguible de un fallo de la capa, y el presupuesto del día se habría
  // gastado sin constar. Cae a pedir confirmación, que es lo que pasaba antes de
  // que existieran los mandatos.
  // ---------------------------------------------------------------------------
  if (evaluation.mandate) {
    const money = typedAmount(parsed.data, tool.declaredAmount);
    const recorded = await recordMandateUse({
      db: ctx.db,
      mandateId: evaluation.mandate.id,
      toolId: tool.id,
      userId: ctx.userId,
      agentId: ctx.agentId,
      surface: evaluation.surface,
      riskLevel: evaluation.classification.riskLevel,
      amount: money?.amount ?? null,
      currency: money?.currency ?? null,
      inputDigest: hashInput(parsed.data),
    });
    if (!recorded) {
      await writeAuditEvent({
        db: ctx.db,
        userId: ctx.userId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        toolId: tool.id,
        input,
        status: 'confirmation_required',
        latencyMs: Math.round(performance.now() - t0),
        metadata: { reason: 'mandate_use_unrecorded', mandateId: evaluation.mandate.id },
        ...risk,
      });
      throw new ConfirmationRequiredError(tool.id, parsed.data);
    }
  }

  // La SEGUNDA puerta, y es independiente de la de seguridad: `gmail.send_draft`
  // lleva `requiresConfirmation: true` puesto por la propia herramienta, y sin
  // esta línea un mandato de «puedes mandar correos a clientes» no haría
  // absolutamente nada — el correo seguiría parándose aquí después de que el
  // veredicto resuelto dijera que siga. Por eso lee `evaluation.mandate` y no
  // vuelve a decidir nada por su cuenta: las dos puertas, un solo veredicto.
  let viaConversationGrace = false;
  if (tool.requiresConfirmation && !opts.confirmed && !evaluation.mandate) {
    // La memoria corta del sí: una confirmación de esta misma herramienta, en
    // esta misma conversación y dentro de su ventana, vale para esta llamada.
    // Solo afloja ESTA puerta — la de seguridad ya pasó, sin consultarla.
    viaConversationGrace = Boolean(
      tool.conversationGrace &&
        (await hasConversationGrace(ctx.db, {
          conversationId: ctx.conversationId,
          userId: ctx.userId,
          toolId: tool.id,
          graceMs: tool.conversationGrace,
        })),
    );
    if (!viaConversationGrace) {
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
      // Not `(err as Error).message`: supabase-js hands back a plain object, so
      // the cast was a lie and the audit row recorded `undefined` for exactly
      // the failures worth auditing.
      metadata: { error: toolErrorMessage(err) },
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
    // Que la auditoría diga cuando un sí heredado abrió la puerta: es la
    // diferencia entre «confirmó» y «se lo habías confirmado hace un rato».
    ...(viaConversationGrace ? { metadata: { reason: 'conversation_grace' } } : {}),
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
        // Una delegación SILENCIOSA es lo peor de las dos cosas: la persona no
        // eligió, y encima no se entera. Si un mandato levantó la pregunta, el
        // resultado lo dice — qué se hizo sin preguntar y por decisión de quién.
        notice: evaluation.mandate
          ? explainDelegation(evaluation.classification, evaluation.mandate)
          : explainFlag(evaluation.classification),
        ...(evaluation.mandate
          ? {
              delegatedBy: evaluation.mandate.label,
              // EL IDENTIFICADOR, NO SOLO EL NOMBRE.
              //
              // La pantalla que ofrece «revocar el permiso» tiene que saber
              // CUÁL revocar. Con solo la etiqueta hay que casarla contra la
              // lista de concesiones por nombre, y dos mandatos pueden llamarse
              // igual — momento en el que la elección correcta es no ofrecer el
              // botón, porque revocar el equivocado quita una autonomía que
              // nadie quiso quitar y deja puesta la que sí molestaba.
              //
              // Es un id, no un secreto: nombra una fila de esta misma empresa
              // que la persona puede abrir, y sin él el botón honesto es no
              // tener botón.
              mandateId: evaluation.mandate.id,
            }
          : {}),
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
