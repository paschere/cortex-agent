import {
  ConfirmationRequiredError,
  RateLimitError,
  SecurityBlockedError,
  ValidationError,
} from '@cortex/core';
import { hashInput, writeAuditEvent } from './audit.js';
import { consumeToken } from './rate-limit.js';
import { SAFE_ACTION_CATALOG } from './safe-actions/catalog.js';
import {
  type ActionGuard,
  ActionInFlightError,
  ActionOutcomeUnknownError,
  guardFor,
  repeatNotice,
  replayNotice,
  runVerify,
  splitRepeatFlag,
  summarizeResult,
  verificationNotice,
  withRepeatFlag,
} from './safe-actions/runtime.js';
import {
  type ClaimOutcome,
  claimAction,
  judge,
  readAction,
  settleFailure,
  settleSuccess,
} from './safe-actions/store.js';
import type { ActionRow, AnySafeActionPolicy, VerifyOutcome } from './safe-actions/types.js';
import { hasConversationGrace } from './security/conversation-grace.js';
import {
  blockExplanation,
  evaluate as evaluateSecurity,
  explainFlag,
  isIncident,
  riskAuditFields,
  writeSecurityEvent,
} from './security/enforce.js';
import { recordMandateUse } from './security/mandate-store.js';
import { explainDelegation, typedAmount } from './security/mandate.js';
import { mandatoryHumanConfirmation } from './security/mandatory-confirmation.js';
import { toolErrorMessage } from './tool-error.js';
import type { AnyTool, ToolContext, ToolDef } from './types.js';

const REGISTRY = new Map<string, AnyTool>();

export function registerTool<I, O>(tool: ToolDef<I, O>): ToolDef<I, O> {
  // Acción segura de repetir (0168): la política propia gana; si no hay, la del
  // catálogo central. Con política, el esquema que ve el modelo gana el campo
  // con el que se pide repetir a sabiendas (ver safe-actions/runtime.ts).
  const policy =
    tool.safeAction ?? (SAFE_ACTION_CATALOG[tool.id] as ToolDef<I, O>['safeAction'] | undefined);
  if (policy) {
    tool.safeAction = policy;
    tool.inputSchema = withRepeatFlag(tool.inputSchema);
  }
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
  opts: {
    confirmed?: boolean;
    /**
     * Repetir a sabiendas una acción ya hecha (0168). Lo pasa la aprobación
     * cuando la tarjeta le enseñó a la persona que era una repetición; el modelo
     * lo pide con el campo `repeatConfirmedByUser` del input.
     */
    allowRepeat?: boolean;
  } = {},
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
  // ACCIÓN SEGURA DE REPETIR (migración 0168). La huella de esta llamada —quién,
  // qué herramienta, con qué datos canonizados, en qué ejecución— se calcula una
  // vez aquí. El campo con el que se pide repetir sale del input antes de que lo
  // vea nadie más: la herramienta recibe sus datos y nada más. `parsed.data`
  // (con el campo) sólo viaja en la petición de confirmación, para que la
  // tarjeta y la aprobación sepan que es una repetición pedida.
  // ---------------------------------------------------------------------------
  const policy = tool.safeAction as AnySafeActionPolicy | undefined;
  const split = policy
    ? splitRepeatFlag(parsed.data)
    : { data: parsed.data, repeatRequested: false };
  const data = split.data as I;
  const allowRepeat = split.repeatRequested || opts.allowRepeat === true;
  let guard: ActionGuard | null = null;
  if (policy) {
    try {
      guard = guardFor(policy, tool.id, data, ctx);
    } catch (err) {
      ctx.logger.warn?.({ err, tool: tool.id }, 'safe-action key failed; running unguarded');
    }
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
    input: data,
    db: ctx.db,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    agentId: ctx.agentId,
    surface: ctx.surface,
    routineId: ctx.routineId,
    scopedMandatesOnly: ctx.scopedMandatesOnly,
    confirmed: opts.confirmed,
  });
  const risk = riskAuditFields(evaluation);

  /** Devolver lo ya hecho, con el aviso, sin ejecutar nada. */
  const replayed = async (row: ActionRow, riskFields: typeof risk): Promise<O> => {
    const notice = replayNotice(row, policy as AnySafeActionPolicy);
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'ok',
      latencyMs: Math.round(performance.now() - t0),
      metadata: {
        reason: 'idempotent_replay',
        idempotency: {
          key: guard?.key.slice(0, 16),
          outcome: 'replayed',
          firstDoneAt: notice.firstDoneAt,
        },
        ...(row.verification
          ? { verification: { status: row.verification, detail: row.verification_detail } }
          : {}),
      },
      ...riskFields,
    });
    const prior = row.result == null ? null : tool.outputSchema.safeParse(row.result);
    const base =
      prior?.success && prior.data && typeof prior.data === 'object'
        ? prior.data
        : ({} as Record<string, unknown>);
    attach(base, '_idempotency', notice);
    return base as O;
  };

  /** Negarse a ejecutar: otra igual está en vuelo, o una anterior quedó a medias. */
  const refuse = async (
    kind: 'in_flight' | 'unknown',
    row: ActionRow,
    riskFields: typeof risk,
  ): Promise<never> => {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'error',
      latencyMs: Math.round(performance.now() - t0),
      metadata: {
        reason: kind === 'in_flight' ? 'idempotency_in_flight' : 'idempotency_unknown',
        idempotency: { key: guard?.key.slice(0, 16), outcome: kind, startedAt: row.claimed_at },
      },
      ...riskFields,
    });
    throw kind === 'in_flight'
      ? new ActionInFlightError(tool.id, row.claimed_at)
      : new ActionOutcomeUnknownError(tool.id, row.claimed_at);
  };
  const securityEventBase = {
    db: ctx.db,
    userId: ctx.userId,
    agentId: ctx.agentId,
    toolId: tool.id,
    input: data,
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
      // Si quien paró fue una regla CEL del tenant, el mensaje la nombra.
      blockExplanation(evaluation),
      tool.id,
      evaluation.classification.riskLevel,
      evaluation.classification.signals,
    );
  }

  // ---------------------------------------------------------------------------
  // ¿YA SE HIZO? — antes de pedir confirmación. No tiene sentido que alguien
  // apruebe algo que ya salió: si la misma acción ya se hizo dentro de su
  // ventana, se devuelve lo de entonces con el aviso, sin tarjeta y sin
  // ejecutar. Va DESPUÉS del bloqueo de seguridad (una llamada bloqueada no
  // recibe ni eso) y sólo lee: el reclamo de verdad llega justo antes del
  // handler, cuando ya pasaron todas las puertas.
  // ---------------------------------------------------------------------------
  if (guard) {
    const prior = await readAction(ctx.db, guard.key);
    if (prior) {
      const verdict = judge(prior, { allowRepeat, now: new Date() });
      if (verdict === 'replay') return replayed(prior, risk);
      if (verdict === 'in_flight' || verdict === 'unknown') await refuse(verdict, prior, risk);
    }
  }

  // A high-risk call is gated even when the tool itself never declared
  // requiresConfirmation — the risk lives in the data and the destination,
  // not in the tool definition.
  if (
    (evaluation.decision === 'confirm' || mandatoryHumanConfirmation(tool.id)) &&
    !opts.confirmed
  ) {
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
    const money = typedAmount(data, tool.declaredAmount);
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
      inputDigest: hashInput(data),
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
  // ---------------------------------------------------------------------------
  // EL RECLAMO (0168). Todas las puertas pasaron; antes de la fila de intención
  // y del handler, esta llamada tiene que ganarse el derecho a ejecutar. Dos
  // llamadas iguales a la vez: una gana, la otra se entera de que está en vuelo.
  // Una ya hecha (en la carrera entre la mirada previa y aquí): se devuelve.
  // ---------------------------------------------------------------------------
  let claim: ClaimOutcome | null = null;
  if (guard) {
    claim = await claimAction(ctx.db, {
      key: guard.key,
      toolId: tool.id,
      userId: ctx.userId,
      conversationId: ctx.conversationId ?? null,
      scope: guard.scope,
      windowMs: guard.windowMs,
      allowRepeat,
    });
    if (claim.kind === 'replay') return replayed(claim.row, riskFinal);
    if (claim.kind === 'in_flight' || claim.kind === 'unknown') {
      await refuse(claim.kind, claim.row, riskFinal);
    }
  }
  const claimedAttempt = claim?.kind === 'claimed' ? claim.attemptId : null;
  const repeatOf: ActionRow | null = claim?.kind === 'claimed' ? claim.repeatOf : null;
  const idempotencyMeta = guard
    ? {
        idempotency: {
          key: guard.key.slice(0, 16),
          outcome: claim?.kind === 'unguarded' ? 'unguarded' : repeatOf ? 'repeated' : 'executed',
          ...(claim?.kind === 'unguarded' ? { reason: claim.reason } : {}),
          ...(repeatOf ? { firstDoneAt: repeatOf.finished_at ?? repeatOf.claimed_at } : {}),
        },
      }
    : {};
  const graceMeta = viaConversationGrace ? { reason: 'conversation_grace' } : {};

  // ---------------------------------------------------------------------------
  // AUDIT-BEFORE-ACT (portado de OpenBot). Para una llamada con efectos, la
  // intención queda escrita ANTES de ejecutar el handler: una acción permitida
  // que luego revienta a medias sigue constando en la secuencia, y un rastro
  // que solo contiene éxitos no puede responder «¿lo intentó?» — miente por
  // omisión justo cuando más importa.
  //
  // Solo blast radius con efectos (escrituras, envíos, bulk): una lectura que
  // falla ya deja su fila `error` después, y pagar un viaje extra de base de
  // datos en cada lectura no compra ninguna verdad nueva. Se espera (await) a
  // propósito: la garantía es «la fila existe antes de que el efecto ocurra»,
  // y un insert en vuelo no es una fila.
  // ---------------------------------------------------------------------------
  if (evaluation.classification.blastRadius !== 'read') {
    await writeAuditEvent({
      db: ctx.db,
      userId: ctx.userId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolId: tool.id,
      input,
      status: 'attempted',
      latencyMs: Math.round(performance.now() - t0),
      ...(viaConversationGrace || guard ? { metadata: { ...graceMeta, ...idempotencyMeta } } : {}),
      ...riskFinal,
    });
  }

  const startedAt = new Date();
  let result: O;
  try {
    const exec = () => tool.handler(data, ctx) as Promise<O>;
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
      metadata: { error: toolErrorMessage(err), ...idempotencyMeta },
      ...riskFinal,
    });
    // Un fallo libera la clave: el siguiente intento puede ejecutar.
    if (guard && claimedAttempt) {
      await settleFailure(ctx.db, {
        key: guard.key,
        attemptId: claimedAttempt,
        error: toolErrorMessage(err),
      });
    }
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
      metadata: { reason: 'output_validation', ...idempotencyMeta },
      ...riskFinal,
    });
    // El handler TERMINÓ: el efecto, casi seguro, ocurrió. Se da por hecha (sin
    // resultado que devolver) para que un reintento no lo haga dos veces.
    if (guard && claimedAttempt) {
      await settleSuccess(ctx.db, {
        key: guard.key,
        attemptId: claimedAttempt,
        windowMs: guard.windowMs,
        result: null,
        summary: 'salida inválida',
        verification: null,
      });
    }
    throw new ValidationError(`Invalid output from ${tool.id}`);
  }

  // ---------------------------------------------------------------------------
  // VERIFICAR (0168). Que la API dijera «ok» no es lo mismo que «está hecho»:
  // la herramienta que sabe cómo mirarlo (el correo en Enviados, el evento en el
  // calendario, la fila en la tabla) lo mira, con tope de tiempo y sin poder
  // romper la llamada. El resultado queda en la fila de auditoría y viaja con la
  // respuesta al modelo.
  // ---------------------------------------------------------------------------
  let verification: VerifyOutcome | null = null;
  if (policy?.verify) {
    verification = await runVerify(
      policy.verify as unknown as Parameters<typeof runVerify<I, O>>[0],
      { input: data, output: outParsed.data, ctx, startedAt },
    );
  }
  if (guard && claimedAttempt) {
    await settleSuccess(ctx.db, {
      key: guard.key,
      attemptId: claimedAttempt,
      windowMs: guard.windowMs,
      result: outParsed.data,
      summary: summarizeResult(outParsed.data),
      verification,
    });
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
    ...(viaConversationGrace || guard || verification
      ? {
          metadata: {
            ...graceMeta,
            ...idempotencyMeta,
            ...(verification ? { verification } : {}),
          },
        }
      : {}),
    ...riskFinal,
  });

  if (outParsed.data && typeof outParsed.data === 'object') {
    if (verification) attach(outParsed.data, '_verification', verificationNotice(verification));
    if (repeatOf) attach(outParsed.data, '_idempotency', repeatNotice(repeatOf));
  }

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

/**
 * Una clave extra en el resultado, fuera del contrato de salida (como
 * `_security`): enumerable, porque MCP y el chat serializan con JSON.stringify.
 */
function attach(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: false });
}
