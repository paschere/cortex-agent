import 'server-only';
import { randomUUID } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { type AnyTool, chatModel, filterTools, runTool } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CoreTool, generateText, tool } from 'ai';
import { emit, preview } from './events';
import { type GraphNode, mapWithConcurrency, nextBatch } from './graph';
import { type PlannedTask, planObjective } from './planner';
import { type RunStatus, TASK_COLUMNS, type TaskStatus } from './types';

/**
 * The execution engine.
 *
 * plan → walk the DAG in parallel waves → synthesise. Everything worth watching
 * is appended to orchestration_events as it happens, because the console is the
 * product here: a multi-agent run that you cannot watch is indistinguishable
 * from a slow one that is stuck.
 *
 * The whole thing is written to be crash-tolerant in one direction only —
 * database state is always advanced BEFORE the work it describes, so a process
 * that dies mid-run leaves rows that say "running" rather than rows that lie
 * about having finished.
 */

/** Parallel sub-agents in flight at once. Configurable per run; this is the default. */
export const DEFAULT_CONCURRENCY = 4;

/** Tool-calling budget for one sub-agent. Enough for a real research loop, not enough to wander. */
const TASK_MAX_STEPS = 10;

/** Caps, in characters. Storage is cheap; a 400 kB prompt is not. */
const RESULT_STORE_LIMIT = 20_000;
const DEPENDENCY_CONTEXT_LIMIT = 6_000;
const SYNTHESIS_INPUT_LIMIT = 8_000;
const TOOL_ARGS_PREVIEW = 1_200;
const TOOL_RESULT_PREVIEW = 2_000;
const ERROR_LIMIT = 2_000;

interface TaskRow extends PlannedTask {
  id: string;
  seq: number;
}

export interface RunOptions {
  runId: string;
  userId: string;
  organizationId: string;
  objective: string;
  concurrency?: number;
}

/** Current status straight from the row — the cancel endpoint writes it from another request. */
async function currentStatus(db: SupabaseClient, runId: string): Promise<RunStatus | null> {
  const { data } = await db
    .from('orchestration_runs')
    .select('status')
    .eq('id', runId)
    .maybeSingle();
  return (data?.status as RunStatus | undefined) ?? null;
}

async function isCancelled(db: SupabaseClient, runId: string): Promise<boolean> {
  return (await currentStatus(db, runId)) === 'cancelled';
}

/**
 * Runs an objective end to end. Never throws: a run that blows up is a run that
 * is recorded as failed, because the caller is a fire-and-forget `after()`
 * callback with nobody left to catch anything.
 */
export async function runOrchestration(opts: RunOptions): Promise<void> {
  const db = getOrgScopedClient(opts.organizationId);
  const { runId, objective } = opts;
  const concurrency = Math.min(Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1), 8);
  let tokens = 0;

  try {
    const agent = await loadAgent(db, 'cortex');

    // The catalogue the planner may draw from is exactly the catalogue the
    // sub-agents may call: the agent's grants, minus every pattern any of the
    // user's teams denies. Narrowing here means a sub-agent can never be handed
    // a tool the security layer would refuse three steps later.
    const denied = await deniedToolPatterns(db, opts.userId);
    const catalogue = filterTools(agent.allowedTools).filter((t) => !isToolDenied(t.id, denied));

    const plan = await planObjective({
      objective,
      tools: catalogue,
      model: agent.defaultModel,
    });
    tokens += plan.tokens;

    if (plan.tasks.length === 0) throw new Error('The planner returned an empty plan.');
    // Cancelling during planning is common — it is the slowest single step.
    if (await isCancelled(db, runId)) {
      await finish(db, runId, 'cancelled', null, tokens);
      return;
    }

    const tasks = await persistPlan(db, runId, plan.tasks);

    await db
      .from('orchestration_runs')
      .update({
        status: 'running',
        plan: { objective, tasks: plan.tasks },
        started_at: new Date().toISOString(),
        total_tokens: tokens,
      })
      .eq('id', runId);

    await emit(db, runId, null, 'plan', {
      objective,
      tasks: tasks.map((t) => ({
        id: t.id,
        seq: t.seq,
        title: t.title,
        instruction: t.instruction,
        status: 'pending' as TaskStatus,
        dependsOn: t.dependsOn,
        agentLabel: t.agentLabel,
        allowedTools: t.allowedTools,
        result: null,
        error: null,
        tokens: 0,
        startedAt: null,
        finishedAt: null,
      })),
    });

    const nodes: GraphNode[] = tasks.map((t) => ({ seq: t.seq, dependsOn: t.dependsOn }));
    const states = new Map<number, TaskStatus>();
    const results = new Map<number, string>();
    const bySeq = new Map(tasks.map((t) => [t.seq, t]));

    for (;;) {
      if (await isCancelled(db, runId)) {
        await finish(db, runId, 'cancelled', null, tokens);
        return;
      }

      const { ready, skip } = nextBatch(nodes, states);

      // Skips cascade one level per call, so they are applied and the graph is
      // re-asked rather than assumed settled.
      if (skip.length > 0) {
        for (const seq of skip) {
          states.set(seq, 'skipped');
          const task = bySeq.get(seq);
          if (!task) continue;
          const reason = 'A task this one depends on did not finish.';
          await db
            .from('orchestration_tasks')
            .update({ status: 'skipped', error: reason, finished_at: new Date().toISOString() })
            .eq('id', task.id);
          await emit(db, runId, task.id, 'task_done', {
            taskId: task.id,
            seq,
            status: 'skipped',
            error: reason,
          });
        }
        continue;
      }

      if (ready.length === 0) break;

      const outcomes = await mapWithConcurrency(ready, concurrency, async (seq) => {
        const task = bySeq.get(seq);
        if (!task) return { seq, status: 'skipped' as TaskStatus, text: '', tokens: 0 };
        return executeTask({
          db,
          runId,
          task,
          objective,
          agentId: agent.id,
          model: agent.defaultModel,
          organizationId: opts.organizationId,
          userId: opts.userId,
          catalogue,
          dependencyResults: task.dependsOn
            .map((d) => ({
              seq: d,
              title: bySeq.get(d)?.title ?? `Task ${d}`,
              text: results.get(d),
            }))
            .filter((d): d is { seq: number; title: string; text: string } => Boolean(d.text)),
        });
      });

      for (const outcome of outcomes) {
        states.set(outcome.seq, outcome.status);
        if (outcome.status === 'completed') results.set(outcome.seq, outcome.text);
        tokens += outcome.tokens;
      }
      await db.from('orchestration_runs').update({ total_tokens: tokens }).eq('id', runId);
    }

    if (await isCancelled(db, runId)) {
      await finish(db, runId, 'cancelled', null, tokens);
      return;
    }

    const completed = [...states.values()].filter((s) => s === 'completed').length;
    // A run with nothing to show for itself is a failure, whatever the reason.
    // A run where some branches died still produced work, and the report says so.
    const status: RunStatus = completed === 0 ? 'failed' : 'completed';

    const synthesis = await synthesize({
      db,
      runId,
      objective,
      model: agent.defaultModel,
      tasks: tasks.map((t) => ({
        seq: t.seq,
        title: t.title,
        status: states.get(t.seq) ?? 'pending',
        text: results.get(t.seq) ?? null,
      })),
    });
    tokens += synthesis.tokens;

    await finish(db, runId, status, synthesis.summary, tokens);
  } catch (err) {
    const message = (err as Error).message.slice(0, ERROR_LIMIT);
    logger.error('orchestrator: run failed', { runId, error: message });
    await emit(db, runId, null, 'error', { message });
    await finish(db, runId, 'failed', null, tokens, message);
  }
}

/** Terminal write: status, summary, tokens, finished_at, plus the closing event. */
async function finish(
  db: SupabaseClient,
  runId: string,
  status: RunStatus,
  summary: string | null,
  tokens: number,
  error?: string,
): Promise<void> {
  await db
    .from('orchestration_runs')
    .update({
      status,
      summary: summary ?? (error ? `**The run failed.**\n\n${error}` : null),
      total_tokens: tokens,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  await emit(db, runId, null, 'run_done', { status, summary, totalTokens: tokens });
}

/** Writes the plan as executable rows and reads back the ids the events need. */
async function persistPlan(
  db: SupabaseClient,
  runId: string,
  planned: PlannedTask[],
): Promise<TaskRow[]> {
  const { data, error } = await db
    .from('orchestration_tasks')
    .insert(
      planned.map((t, index) => ({
        run_id: runId,
        seq: index + 1,
        title: t.title,
        instruction: t.instruction,
        depends_on: t.dependsOn,
        agent_label: t.agentLabel,
        allowed_tools: t.allowedTools,
      })),
    )
    .select(TASK_COLUMNS);
  if (error || !data) throw new Error(`Could not save the plan: ${error?.message}`);

  return (data as Record<string, unknown>[])
    .map((row) => ({
      id: row.id as string,
      seq: row.seq as number,
      title: row.title as string,
      instruction: row.instruction as string,
      agentLabel: (row.agent_label as string | null) ?? 'Agent',
      dependsOn: ((row.depends_on as number[] | null) ?? []).filter((n) => Number.isInteger(n)),
      allowedTools: (row.allowed_tools as string[] | null) ?? [],
    }))
    .sort((a, b) => a.seq - b.seq);
}

interface TaskOutcome {
  seq: number;
  status: TaskStatus;
  text: string;
  tokens: number;
}

/**
 * One sub-agent: its own brief, its own narrow toolset, its own transcript.
 *
 * Never throws. A task that fails is recorded as failed and the caller keeps
 * walking the graph — one dead branch must not take the run down with it.
 */
async function executeTask(args: {
  db: SupabaseClient;
  runId: string;
  task: TaskRow;
  objective: string;
  agentId: string;
  model: string | null;
  organizationId: string;
  userId: string;
  catalogue: AnyTool[];
  dependencyResults: Array<{ seq: number; title: string; text: string }>;
}): Promise<TaskOutcome> {
  const { db, runId, task } = args;
  const startedAt = new Date().toISOString();

  const catalogueIds = new Set(args.catalogue.map((t) => t.id));
  // filterTools understands the same 'family.*' patterns the planner may emit;
  // intersecting with the catalogue re-applies the user's grants and denials.
  const tools = filterTools(task.allowedTools).filter((t) => catalogueIds.has(t.id));

  await db
    .from('orchestration_tasks')
    .update({ status: 'running', started_at: startedAt })
    .eq('id', task.id);
  await emit(db, runId, task.id, 'task_start', {
    taskId: task.id,
    seq: task.seq,
    title: task.title,
    agentLabel: task.agentLabel,
    allowedTools: tools.map((t) => t.id),
    startedAt,
  });

  const ctx = {
    ...buildToolContext({
      organizationId: args.organizationId,
      userId: args.userId,
      agentId: args.agentId,
    }),
    // No human is watching a sub-agent, which is exactly what 'schedule' means
    // to the security layer: nothing can be confirmed interactively.
    surface: 'schedule' as const,
  };

  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    tools.map((t) => [
      t.id.replaceAll('.', '_'),
      tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (input, { abortSignal }) => {
          const callId = randomUUID();
          const t0 = Date.now();
          await emit(db, runId, task.id, 'tool_call', {
            taskId: task.id,
            callId,
            toolId: t.id,
            args: preview(input, TOOL_ARGS_PREVIEW),
          });
          try {
            const result = await runTool(t, input, { ...ctx, signal: abortSignal });
            await emit(db, runId, task.id, 'tool_result', {
              taskId: task.id,
              callId,
              toolId: t.id,
              ok: true,
              preview: preview(result, TOOL_RESULT_PREVIEW),
              durationMs: Date.now() - t0,
            });
            return result;
          } catch (err) {
            const confirmation = err instanceof ConfirmationRequiredError;
            const message = confirmation
              ? 'This tool needs a human to approve it, and this run is unattended. Report that it was skipped and continue.'
              : (err as Error).message.slice(0, 600);
            await emit(db, runId, task.id, 'tool_result', {
              taskId: task.id,
              callId,
              toolId: t.id,
              ok: false,
              preview: message,
              durationMs: Date.now() - t0,
            });
            // Handed back to the model rather than thrown: a failed tool should
            // make the sub-agent adapt, not end its turn.
            return (confirmation
              ? { __skipped: true, tool: t.id, reason: message }
              : { __error: true, tool: t.id, message }) as unknown as never;
          }
        },
      }),
    ]),
  );

  const context = args.dependencyResults
    .map(
      (d) =>
        `### Output of task ${d.seq} — ${d.title}\n${d.text.slice(0, DEPENDENCY_CONTEXT_LIMIT)}`,
    )
    .join('\n\n');

  const system = `You are "${task.agentLabel}", one sub-agent in a multi-agent run. You own exactly one task and nothing else.

OVERALL OBJECTIVE OF THE RUN
${args.objective}

YOUR TASK
${task.title}
${context ? `\nWHAT THE TASKS YOU DEPEND ON PRODUCED\n${context}\n` : ''}
How you work:
- Nobody is watching. Never ask a question, never wait for approval — there is no one to answer.
- Use your tools to get real data. Do not invent facts, names or figures.
- If a tool returns __error or __skipped, say so in your answer and work around it.
- Stay inside your task. Another sub-agent is handling the rest, and a separate final report is written afterwards.
- Finish with a self-contained answer: what you found or produced, concretely, in the language of the objective. That text is the only thing the rest of the run will see from you.`;

  try {
    const result = await generateText({
      model: chatModel(args.model),
      system,
      messages: [{ role: 'user', content: task.instruction }],
      tools: aiTools,
      toolChoice: 'auto',
      maxSteps: TASK_MAX_STEPS,
    });

    const text = result.text.trim();
    const tokens = result.usage?.totalTokens ?? 0;
    if (!text) throw new Error('The sub-agent produced no final text.');

    const stored = text.slice(0, RESULT_STORE_LIMIT);
    const finishedAt = new Date().toISOString();
    await db
      .from('orchestration_tasks')
      .update({ status: 'completed', result: stored, tokens, finished_at: finishedAt })
      .eq('id', task.id);
    await emit(db, runId, task.id, 'message', { taskId: task.id, text: stored });
    await emit(db, runId, task.id, 'task_done', {
      taskId: task.id,
      seq: task.seq,
      status: 'completed',
      result: stored,
      tokens,
      finishedAt,
    });
    return { seq: task.seq, status: 'completed', text: stored, tokens };
  } catch (err) {
    const message = (err as Error).message.slice(0, ERROR_LIMIT);
    const finishedAt = new Date().toISOString();
    await db
      .from('orchestration_tasks')
      .update({ status: 'failed', error: message, finished_at: finishedAt })
      .eq('id', task.id);
    await emit(db, runId, task.id, 'error', { taskId: task.id, message });
    await emit(db, runId, task.id, 'task_done', {
      taskId: task.id,
      seq: task.seq,
      status: 'failed',
      error: message,
      finishedAt,
    });
    return { seq: task.seq, status: 'failed', text: '', tokens: 0 };
  }
}

/**
 * The final report: one call that reads every sub-agent's answer and writes the
 * thing the person actually asked for.
 *
 * Failure here degrades to a mechanical concatenation rather than failing the
 * run — the work is already done and paid for, so it must still be readable.
 */
async function synthesize(args: {
  db: SupabaseClient;
  runId: string;
  objective: string;
  model: string | null;
  tasks: Array<{ seq: number; title: string; status: TaskStatus; text: string | null }>;
}): Promise<{ summary: string | null; tokens: number }> {
  const done = args.tasks.filter((t) => t.text);
  const fallback = done.map((t) => `## ${t.title}\n\n${t.text}`).join('\n\n---\n\n');

  if (done.length === 0) return { summary: null, tokens: 0 };

  const body = args.tasks
    .map((t) =>
      t.text
        ? `### Task ${t.seq} — ${t.title}\n${t.text.slice(0, SYNTHESIS_INPUT_LIMIT)}`
        : `### Task ${t.seq} — ${t.title}\n(${t.status})`,
    )
    .join('\n\n');

  try {
    const result = await generateText({
      model: chatModel(args.model),
      system: `You write the final report of a multi-agent run. Several sub-agents each did one piece; you are the only one who sees all of it.

Write the answer to the objective, not a description of the process. Markdown, headings where they help, concrete figures and names from the sub-agent output and nothing invented. If a task failed or was skipped, state plainly what is therefore missing — a gap named is useful, a gap papered over is not. Answer in the language of the objective.`,
      messages: [
        {
          role: 'user',
          content: `OBJECTIVE\n${args.objective}\n\nWHAT THE SUB-AGENTS PRODUCED\n${body}\n\nWrite the report.`,
        },
      ],
      // Headroom for extended thinking AND the report: Claude counts both
      // against maxTokens, so a 4k cap here truncates long reports mid-sentence.
      maxTokens: 8192,
    });
    const summary = result.text.trim();
    return {
      summary: summary || fallback,
      tokens: result.usage?.totalTokens ?? 0,
    };
  } catch (err) {
    logger.error('orchestrator: synthesis failed, falling back to concatenation', {
      runId: args.runId,
      error: (err as Error).message,
    });
    return { summary: fallback, tokens: 0 };
  }
}
