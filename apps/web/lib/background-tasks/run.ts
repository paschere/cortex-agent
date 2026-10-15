import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { idsOf } from '@/lib/granted-tools';
import { enqueueJob } from '@/lib/jobs';
import type { StepLike } from '@/lib/message-parts';
import { sanitizeHistory } from '@/lib/strip-empty-messages';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { createToolCallRepair } from '@/lib/tool-call-repair';
import { modelToolContent } from '@/lib/tool-result-cap';
import { createTurnBudget, hardMarginMs, runWithinBudget } from '@/lib/turn-budget';
import { maxStepsFor } from '@/lib/turn-continuation';
import { dropTrailingNonUser } from '@/lib/turn-messages';
import { createTurnPersister } from '@/lib/turn-persist';
import { type TurnOutcome, digestToolWork, withoutNotes } from '@/lib/turn-transcript';
import {
  type AnyTool,
  anthropicStepCache,
  chatModel,
  checkMeter,
  describePendingCall,
  enabledModules,
  filterTools,
  isRefused,
  recordModelUsage,
  runTool,
  selectToolsForTurn,
  sumCacheSteps,
  toolAllowedByModules,
  toolErrorDetail,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CoreMessage, type CoreTool, generateText, tool } from 'ai';
import { noteTask } from './notify';
import { TASK_RUN_JOB, type TaskRecord, loadTask } from './repository';
import {
  type SegmentEnd,
  type TaskApproval,
  afterSegment,
  approvalsNote,
  deadlineFor,
  openApprovals,
  segmentBudgetMs,
} from './status';

/**
 * EL CORREDOR DE UNA TAREA EN SEGUNDO PLANO: UNA TANDA POR INVOCACIÓN.
 *
 * ===========================================================================
 * QUÉ ES IGUAL QUE EN EL CHAT, Y QUÉ NO
 * ===========================================================================
 * Igual (es la misma maquinaria, no una copia floja):
 *   - el mismo agente (`loadAgent(db, 'cortex')`), el mismo `buildSystemPrompt`
 *     (memorias, ficha de la empresa, reglas), el mismo modelo;
 *   - las mismas herramientas con el mismo filtrado: concesiones del agente,
 *     lista de denegados de los equipos de la persona, módulos de la empresa y
 *     la misma selección semántica por pedido (`selectToolsForTurn`);
 *   - cada llamada pasa por `runTool` —riesgo, confirmación, límite de
 *     frecuencia, auditoría— con la superficie `web`, o sea con los MISMOS
 *     permisos que la persona tiene escribiéndole al chat;
 *   - el presupuesto por paso (`runWithinBudget`: ninguna herramienta se queda
 *     con la tanda) y la escritura progresiva de la respuesta
 *     (`createTurnPersister`: la fila del asistente se actualiza paso a paso,
 *     así que quien abra la conversación en otro aparato ve avanzar a Cortex).
 *
 * Distinto:
 *   - NADIE ESTÁ MIRANDO. Una herramienta que pide confirmación no puede
 *     mostrar una tarjeta: la llamada se DEJA PARADA en `mcp_pending_actions`
 *     (la misma cola de /approvals, con el mismo botón) y la tarea pasa a «te
 *     necesita». Cuando la persona responde, la tarea sigue sola. Nada que
 *     requiera confirmación se ejecuta sin que ella lo apruebe.
 *   - SIN lo que sólo tiene sentido con una persona delante: preguntas de
 *     opción (`ask_choice`), señalar la pantalla, servidores MCP externos y
 *     herramientas propias de la empresa (en esta primera versión).
 *   - EL TIEMPO: una tanda cabe en una llamada de la app (el puente corre con
 *     maxDuration=800 s). Si el trabajo sigue, la tanda se cierra limpia y se
 *     ENCOLA OTRA; entre tandas el único estado es la base de datos (la
 *     conversación y la fila de la tarea). El tope de toda la tarea son 20
 *     minutos de trabajo (`TASK_CAP_MS`); esperar a la persona no gasta tope.
 *
 * ===========================================================================
 * IDEMPOTENCIA
 * ===========================================================================
 * La tanda se RECLAMA con una actualización condicional (`claim`): dos
 * invocaciones del mismo trabajo no corren a la vez. Si una tanda muere a la
 * mitad (la plataforma la mata), el barrido (`sweepTasks`) la encola otra vez
 * una sola vez por tanda perdida; las herramientas con efectos ya tienen su
 * guarda de repetición (0168), y lo que la tanda muerta dejó escrito en la
 * conversación se le entrega a la siguiente como «trabajo ya hecho».
 */

/** Cuánto vive una acción parada: más que los 15 min del chat, porque nadie está esperando en la pantalla. */
export const TASK_APPROVAL_TTL_MS = 24 * 60 * 60_000;

const HEARTBEAT_EVERY_MS = 8_000;
/** Una tanda reclamada hace menos que esto se considera viva (la reclamación no se roba). */
const CLAIM_GRACE_MS = 120_000;
const HISTORY_ROWS = 24;
/** Techo de la tanda (con el margen de guardado adentro); el puente corta a 800 s. */
const SEGMENT_LIMIT_MS = 700_000;

export const TASK_RULES = `MODO TAREA EN SEGUNDO PLANO
Estás trabajando en segundo plano, sin nadie mirando la pantalla: la persona puede haber cerrado el navegador.
- No hagas preguntas ni esperes respuesta. Si algo es ambiguo, elige lo más razonable, dilo y sigue.
- Si una herramienta te devuelve __queued_for_approval, la acción NO se hizo: quedó esperando el visto bueno de la persona. No la repitas ni la des por hecha; sigue con todo lo que no dependa de ella y, al final, di con claridad qué quedó pendiente de aprobar.
- Si una herramienta devuelve __error, dilo y busca otro camino; no inventes datos.
- Cuando generes archivos (informes, presentaciones, hojas, descargas), nómbralos con su enlace en la respuesta final.
- Termina con un resumen claro de lo que hiciste, lo que encontraste y lo que falta. Ese texto es lo que la persona lee al volver.`;

type Candidate = { id: string; family: string; description: string; ref: AnyTool };

async function claim(db: SupabaseClient, task: TaskRecord, now: Date): Promise<TaskRecord | null> {
  const graceCut = new Date(now.getTime() - CLAIM_GRACE_MS).toISOString();
  const started = task.startedAt ? new Date(task.startedAt) : null;
  // Esperar a la persona no gasta tope: al retomar se le devuelve lo que le quedaba.
  let deadline: Date;
  if (!started) deadline = deadlineFor(now);
  else if (task.status === 'needs_you') {
    const left = task.deadlineAt
      ? Math.max(
          2 * 60_000,
          new Date(task.deadlineAt).getTime() - new Date(task.updatedAt).getTime(),
        )
      : 2 * 60_000;
    deadline = new Date(now.getTime() + left);
  } else deadline = task.deadlineAt ? new Date(task.deadlineAt) : deadlineFor(started);

  const { data, error } = await db
    .from('background_tasks')
    .update({
      status: 'working',
      segment: task.segment + 1,
      started_at: (started ?? now).toISOString(),
      deadline_at: deadline.toISOString(),
      heartbeat_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', task.id)
    .or(
      `status.in.(queued,needs_you),and(status.eq.working,or(heartbeat_at.is.null,heartbeat_at.lt.${graceCut}))`,
    )
    .select('id')
    .maybeSingle();
  if (error || !data) return null;
  return loadTask(db, task.id);
}

async function finishTask(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from('background_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error)
    logger.error({ error: error.message, taskId: id }, 'tasks: no se pudo guardar el estado');
}

/** El historial para el modelo: la conversación, y si quedó trabajo a medias, su resumen. */
async function buildMessages(
  db: SupabaseClient,
  task: TaskRecord,
): Promise<{ messages: CoreMessage[]; lastUser: string }> {
  const rows: Array<{ id?: string; role: string; content: string }> = [];
  if (task.conversationId) {
    const { data } = await db
      .from('messages')
      .select('id, role, content')
      .eq('conversation_id', task.conversationId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_ROWS);
    rows.push(...((data ?? []) as typeof rows).reverse());
  }
  let messages: CoreMessage[] = rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: withoutNotes(r.content ?? '') }));
  if (messages.length === 0) messages = [{ role: 'user', content: task.prompt }];

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content;
  const needsNudge =
    task.segment > 1 || task.mode === 'continue' || messages.at(-1)?.role !== 'user';
  if (needsNudge) {
    let digest = '';
    const lastAssistant = [...rows].reverse().find((r) => r.role === 'assistant');
    if (lastAssistant?.id) {
      const { data } = await db
        .from('messages')
        .select('parts')
        .eq('id', lastAssistant.id)
        .single();
      digest = digestToolWork((data as { parts?: unknown } | null)?.parts);
    }
    const note = approvalsNote(task.approvals);
    messages.push({
      role: 'user',
      content: [
        'Sigue con la tarea desde donde quedaste, sin repetir lo que ya hiciste.',
        digest,
        note,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  return {
    messages: dropTrailingNonUser(sanitizeHistory(messages)),
    lastUser: typeof lastUser === 'string' ? lastUser : task.prompt,
  };
}

export interface SegmentResult {
  status: TaskRecord['status'] | 'skipped';
  requeued?: boolean;
  detail?: string;
}

/** Una tanda de la tarea. Nunca lanza hacia el trabajo: lo que falla queda en la fila. */
export async function runTaskSegment(opts: {
  taskId: string;
  organizationId: string;
}): Promise<SegmentResult> {
  const db = getOrgScopedClient(opts.organizationId);
  const loaded = await loadTask(db, opts.taskId);
  if (!loaded) return { status: 'skipped', detail: 'no such task' };
  if (['done', 'failed', 'cancelled'].includes(loaded.status)) {
    return { status: 'skipped', detail: loaded.status };
  }
  const nowAtStart = new Date();
  if (loaded.cancelRequestedAt) {
    await finishTask(db, loaded.id, { status: 'cancelled', finished_at: nowAtStart.toISOString() });
    return { status: 'cancelled' };
  }
  // «Te necesita» sin respuesta todavía: este trabajo no es el momento de seguir.
  if (loaded.status === 'needs_you' && openApprovals(loaded.approvals).length > 0) {
    return { status: 'needs_you', detail: 'still waiting for the person' };
  }

  const task = await claim(db, loaded, nowAtStart);
  if (!task) return { status: 'skipped', detail: 'claimed elsewhere' };

  try {
    return await runClaimed(db, task);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1500);
    logger.error({ err, taskId: task.id }, 'tasks: segment crashed');
    await finishTask(db, task.id, {
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
      heartbeat_at: null,
    });
    const fresh = (await loadTask(db, task.id)) ?? task;
    await noteTask(fresh, 'failed');
    return { status: 'failed', detail: message };
  }
}

async function runClaimed(db: SupabaseClient, task: TaskRecord): Promise<SegmentResult> {
  // Una tarea movida a segundo plano desde un turno del chat en marcha: ese turno guarda su
  // respuesta parcial justo después de soltar la conexión. Se le da un momento para que la
  // tanda vea lo que el chat ya había hecho.
  if (task.segment === 1 && task.mode === 'continue') {
    const wait = 10_000 - (Date.now() - new Date(task.queuedAt).getTime());
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
  }
  const started = Date.now();

  // El cupo de respuestas del plan, igual que el chat: sólo al empezar la tarea.
  if (task.segment === 1) {
    const answers = await checkMeter(db, 'answers');
    if (isRefused(answers)) {
      const message =
        answers.blockedBy === 'billing'
          ? 'La cuenta está en solo lectura por cobro; Cortex no puede trabajar hasta que se regularice.'
          : `Se acabaron las respuestas de tu plan este mes (${answers.used} de ${answers.limit}).`;
      await finishTask(db, task.id, {
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
        heartbeat_at: null,
      });
      await noteTask({ ...task, error: message }, 'failed');
      return { status: 'failed', detail: 'plan limit' };
    }
  }

  const deadlineAt = task.deadlineAt ? new Date(task.deadlineAt) : deadlineFor(new Date(started));
  const segmentMs = segmentBudgetMs(deadlineAt, new Date(started));
  if (segmentMs < 30_000) {
    return closeSegment(db, task, {
      end: 'out_of_time',
      steps: [],
      text: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      outcome: 'complete',
      started,
      finalText: null,
    });
  }

  const agent = await loadAgent(db, 'cortex');
  if (!task.conversationId)
    throw new Error('La tarea no tiene conversación donde guardar su avance.');

  // --- Herramientas: el mismo filtrado que el chat ---------------------------
  const [denied, modulesOn] = await Promise.all([
    deniedToolPatterns(db, task.userId),
    enabledModules(db),
  ]);
  const candidates: Candidate[] = filterTools(agent.allowedTools)
    .filter((t) => denied.length === 0 || !isToolDenied(t.id, denied))
    .filter((t) => toolAllowedByModules(t.id, modulesOn))
    // Una tarea no abre otra tarea: se evita el bucle.
    .filter((t) => !t.id.startsWith('tasks.'))
    .map((t) => ({
      id: t.id,
      family: t.id.split('.')[0] ?? t.id,
      description: t.description,
      ref: t,
    }));

  const { messages, lastUser } = await buildMessages(db, task);
  const selection = await selectToolsForTurn({
    db,
    tools: candidates,
    query: `${task.prompt}\n${lastUser}`.slice(0, 2000),
  });
  const selected = selection.tools;

  const { system } = await buildSystemPrompt({
    organizationId: task.organizationId,
    userId: task.userId,
    basePrompt: agent.systemPrompt,
  });

  // --- Presupuesto y cancelación ---------------------------------------------
  const cancel = new AbortController();
  const limitMs = Math.max(
    60_000,
    Math.min(SEGMENT_LIMIT_MS, segmentMs + hardMarginMs(SEGMENT_LIMIT_MS)),
  );
  const budget = createTurnBudget({ limitMs, startedAt: started, parent: cancel.signal });
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const { data } = await db
          .from('background_tasks')
          .select('status, cancel_requested_at')
          .eq('id', task.id)
          .maybeSingle();
        const row = data as { status?: string; cancel_requested_at?: string | null } | null;
        if (row?.cancel_requested_at || row?.status === 'cancelled') {
          cancel.abort();
          return;
        }
        await db
          .from('background_tasks')
          .update({ heartbeat_at: new Date().toISOString() })
          .eq('id', task.id);
      } catch {
        // El latido es cosmética de vigilancia: perder uno no tumba la tanda.
      }
    })();
  }, HEARTBEAT_EVERY_MS);

  const ctx = buildToolContext({
    organizationId: task.organizationId,
    userId: task.userId,
    agentId: agent.id,
    conversationId: task.conversationId,
    surface: 'web',
  });

  const staged = new Map<string, string>();
  const stage = async (t: AnyTool, input: unknown): Promise<Record<string, unknown>> => {
    const key = `${t.id}:${JSON.stringify(input)}`;
    const known = staged.get(key);
    if (known) {
      return { __queued_for_approval: true, approvalId: known, tool: t.id, duplicate: true };
    }
    const { data, error } = await db
      .from('mcp_pending_actions')
      .insert({
        user_id: task.userId,
        agent_id: agent.id,
        tool_id: t.id,
        input,
        expires_at: new Date(Date.now() + TASK_APPROVAL_TTL_MS).toISOString(),
        staged_via: 'web',
      })
      .select('id')
      .single();
    if (error || !data) {
      return {
        __error: true,
        tool: t.id,
        message: 'No pude dejar la acción esperando tu visto bueno. No se hizo.',
      };
    }
    const approvalId = (data as { id: string }).id;
    staged.set(key, approvalId);
    const fresh = (await loadTask(db, task.id))?.approvals ?? [];
    const entry: TaskApproval = {
      id: approvalId,
      toolId: t.id,
      summary: describePendingCall(t.id, input),
    };
    await db
      .from('background_tasks')
      .update({ pending_approvals: [...fresh, entry] })
      .eq('id', task.id);
    return {
      __queued_for_approval: true,
      approvalId,
      tool: t.id,
      message:
        'Esta acción necesita el visto bueno de la persona y NO se ejecutó: quedó esperando. Sigue con lo demás y menciónala al final como pendiente.',
    };
  };

  // Lo concedido a esta tarea: el mismo filtrado que el chat (agente, equipos,
  // módulos), para que research.parallel reparta piezas con los permisos justos.
  const grantedToolIds = idsOf(candidates);
  let toolSteps = 0;
  const exec = (t: AnyTool, args: unknown, abortSignal: AbortSignal | undefined) =>
    runWithinBudget(budget, t.id, abortSignal, async (signal) => {
      try {
        return await runTool(t, args, { ...ctx, signal, grantedToolIds });
      } catch (err) {
        if (err instanceof ConfirmationRequiredError) {
          return (await stage(t, err.input)) as unknown as never;
        }
        logger.error('task tool failed', { tool: t.id, taskId: task.id, ...toolErrorDetail(err) });
        return { __error: true, tool: t.id, message: toolErrorMessage(err) } as unknown as never;
      } finally {
        toolSteps += 1;
      }
    });

  const aiTools: Record<string, CoreTool> = {};
  for (const c of selected) {
    const t = c.ref;
    aiTools[t.id.replaceAll('.', '_')] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: (args, { abortSignal }) => exec(t, args, abortSignal),
      experimental_toToolResultContent: modelToolContent,
    });
  }

  // --- La escritura progresiva de la respuesta --------------------------------
  const steps: StepLike[] = [];
  const persister = createTurnPersister({
    writer: {
      insert: async (row) => {
        const { data, error } = await db
          .from('messages')
          .insert({ conversation_id: task.conversationId, role: 'assistant', ...row })
          .select('id')
          .single();
        return { id: (data?.id as string | undefined) ?? null, error: error?.message };
      },
      update: async (id, row) => {
        const { error } = await db.from('messages').update(row).eq('id', id);
        return { error: error?.message };
      },
    },
    log: (message, detail) => logger.error(message, { taskId: task.id, ...detail }),
  });

  const usage = { promptTokens: 0, completionTokens: 0 };
  // 0228: la entrada por paso con su caché, para ponerle precio a la tanda.
  const cacheSteps: Array<{ read: number; written: number; promptTokens: number }> = [];
  let end: SegmentEnd = 'finished';
  let finishReason: string | undefined;
  let finalText: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await generateText({
      model: chatModel(agent.defaultModel),
      system: `${system}\n\n${TASK_RULES}`,
      messages,
      tools: aiTools,
      toolChoice: 'auto',
      maxSteps: Math.max(maxStepsFor(limitMs), 24),
      abortSignal: budget.signal,
      experimental_repairToolCall: createToolCallRepair({
        signal: budget.signal,
        surface: 'chat',
      }),
      onStepFinish: (step) => {
        usage.promptTokens += step.usage?.promptTokens || 0;
        usage.completionTokens += step.usage?.completionTokens || 0;
        cacheSteps.push({
          ...anthropicStepCache(step.providerMetadata),
          promptTokens: step.usage?.promptTokens || 0,
        });
        steps.push({
          text: step.text,
          reasoning: typeof step.reasoning === 'string' ? step.reasoning : undefined,
          toolCalls: step.toolCalls as StepLike['toolCalls'],
          toolResults: step.toolResults as StepLike['toolResults'],
        });
        persister.checkpoint(steps);
        void db
          .from('background_tasks')
          .update({
            steps_count: task.stepsCount + steps.length,
            heartbeat_at: new Date().toISOString(),
          })
          .eq('id', task.id);
      },
    });
    finishReason = result.finishReason;
    finalText = result.text.trim() || null;
    // Se acabaron los pasos de la tanda con el trabajo aún en marcha: sigue en la próxima.
    if (finishReason === 'tool-calls') end = 'out_of_time';
  } catch (err) {
    const why = budget.reason();
    if (cancel.signal.aborted) end = 'cancelled';
    else if (why === 'deadline') end = 'out_of_time';
    else {
      end = 'error';
      errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 1500);
      logger.error({ err, taskId: task.id }, 'tasks: model turn failed');
    }
  } finally {
    clearInterval(heartbeat);
    budget.dispose();
  }

  const outcome: TurnOutcome =
    end === 'finished' || end === 'out_of_time'
      ? 'complete'
      : end === 'cancelled'
        ? 'client'
        : 'error';
  return closeSegment(db, task, {
    end,
    steps,
    text: finalText ?? '',
    usage,
    outcome,
    started,
    finalText,
    errorMessage,
    persister,
    agentId: agent.id,
    model: agent.defaultModel,
    toolSteps,
    cacheSteps,
  });
}

interface CloseInput {
  end: SegmentEnd;
  steps: StepLike[];
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  outcome: TurnOutcome;
  started: number;
  finalText: string | null;
  errorMessage?: string | null;
  persister?: ReturnType<typeof createTurnPersister>;
  agentId?: string;
  model?: string | null;
  toolSteps?: number;
  cacheSteps?: Array<{ read: number; written: number; promptTokens: number }>;
}

async function closeSegment(
  db: SupabaseClient,
  task: TaskRecord,
  input: CloseInput,
): Promise<SegmentResult> {
  const now = new Date();
  const fresh = (await loadTask(db, task.id)) ?? task;
  const cancelled = input.end === 'cancelled' || Boolean(fresh.cancelRequestedAt);
  const end: SegmentEnd = cancelled ? 'cancelled' : input.end;

  const open = openApprovals(fresh.approvals);
  const deadline = fresh.deadlineAt ? new Date(fresh.deadlineAt) : null;
  const capReached = deadline ? deadline.getTime() - now.getTime() < 45_000 : false;
  const next = afterSegment({ end, pendingApprovals: open.length, capReached });

  // Al llegar al tope sin terminar, la nota de interrupción queda escrita en la conversación.
  const persistOutcome: TurnOutcome =
    next.reason === 'cap_reached' && input.outcome === 'complete' ? 'deadline' : input.outcome;
  if (input.persister) await input.persister.finalize(input.steps, persistOutcome);

  const patch: Record<string, unknown> = {
    status: next.status,
    tokens_in: fresh.tokensIn + input.usage.promptTokens,
    tokens_out: fresh.tokensOut + input.usage.completionTokens,
    steps_count:
      fresh.stepsCount > task.stepsCount ? fresh.stepsCount : task.stepsCount + input.steps.length,
    heartbeat_at: next.requeue ? null : now.toISOString(),
  };
  if (next.status === 'done') {
    patch.result =
      (input.finalText ?? '').slice(0, 59_000) ||
      (next.reason === 'cap_reached'
        ? 'La tarea llegó a su tope de 20 minutos. Lo avanzado quedó en la conversación.'
        : 'La tarea terminó sin un resumen escrito; revisa la conversación.');
    patch.finished_at = now.toISOString();
  } else if (next.status === 'failed') {
    patch.error = input.errorMessage ?? 'La tarea no pudo terminar.';
    patch.finished_at = now.toISOString();
  } else if (next.status === 'cancelled') {
    patch.finished_at = now.toISOString();
  } else if (next.status === 'needs_you' && input.finalText) {
    patch.result = input.finalText.slice(0, 59_000);
  }
  await finishTask(db, task.id, patch);

  // 0228: el consumo de la tanda con su precio (modelo + caché), por tarea.
  if (input.model && input.usage.promptTokens + input.usage.completionTokens > 0) {
    const spent = sumCacheSteps(input.cacheSteps ?? []);
    await recordModelUsage(
      db,
      {
        userId: task.userId,
        conversationId: task.conversationId,
        taskId: task.id,
        surface: 'task',
        source: 'task',
        model: input.model,
        steps: input.steps.length,
        inputTokens: input.cacheSteps?.length ? spent.input : input.usage.promptTokens,
        cacheReadTokens: spent.cacheRead,
        cacheWriteTokens: spent.cacheWrite,
        outputTokens: input.usage.completionTokens,
      },
      logger,
    );
  }

  // Auditoría de la tanda, como la del turno del chat.
  if (input.agentId && task.conversationId) {
    await db
      .from('audit_events')
      .insert({
        user_id: task.userId,
        agent_id: input.agentId,
        conversation_id: task.conversationId,
        tool_id: '__agent_turn',
        input_hash: 'turn',
        status: end === 'finished' || end === 'out_of_time' ? 'ok' : 'error',
        latency_ms: Date.now() - input.started,
        metadata: {
          model: input.model,
          tokensIn: input.usage.promptTokens,
          tokensOut: input.usage.completionTokens,
          background: true,
          taskId: task.id,
          segment: task.segment,
          ...(end === 'finished' ? {} : { outcome: end }),
        },
      })
      .then(undefined, () => undefined);
  }

  const after = (await loadTask(db, task.id)) ?? { ...fresh, status: next.status };
  if (next.requeue) {
    const ok = await enqueueJob(TASK_RUN_JOB, {
      taskId: task.id,
      organizationId: task.organizationId,
    }).catch(() => false);
    if (!ok) {
      await finishTask(db, task.id, {
        status: 'failed',
        error: 'No se pudo encolar la siguiente tanda de la tarea.',
        finished_at: new Date().toISOString(),
      });
      await noteTask({ ...after, error: 'No se pudo encolar la siguiente tanda.' }, 'failed');
      return { status: 'failed', detail: 'enqueue failed' };
    }
    return { status: 'working', requeued: true };
  }
  if (next.status === 'done') await noteTask(after, 'finished');
  else if (next.status === 'failed') await noteTask(after, 'failed');
  else if (next.status === 'needs_you') await noteTask(after, 'needs_you', open[0]?.summary);
  return { status: next.status };
}
