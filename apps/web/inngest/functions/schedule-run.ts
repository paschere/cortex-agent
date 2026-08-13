import { buildToolContext } from '@/lib/agent';
import { sendEmail } from '@/lib/email';
import { renderRoutineResultEmail } from '@/lib/email-templates';
import { sendChatDm, toChatText } from '@/lib/google-chat';
import { inngest } from '@/lib/inngest';
import { noteRoutineRun } from '@/lib/notifications/producers';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { chatModel } from '@cortex/agent-tools';
import {
  filterTools,
  getTool,
  runTool,
  toolErrorDetail,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type CoreTool, generateText, tool } from 'ai';

const MAX_OUTPUT_CHARS = 8000;

interface JobRow {
  id: string;
  organization_id: string;
  user_id: string;
  agent_id: string;
  name: string;
  kind: 'tool' | 'agent';
  tool_id: string | null;
  tool_input: Record<string, unknown> | null;
  instruction: string | null;
  schedule_kind: 'once' | 'cron';
  status: string;
  allow_unattended_writes: boolean;
  notify_conversation: boolean;
  notify_email: boolean;
  conversation_id: string | null;
  recipients: string[];
  is_global: boolean;
  user_email: string | null;
  timezone: string | null;
  /** Already advanced to the following occurrence by the dispatcher. */
  next_run_at: string | null;
}

interface ExecResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Wall-clock time the run itself took, for the result email. */
  durationMs?: number;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : s;
}

/**
 * The same result, shaped for a Google Chat DM: markdown flattened into Chat's
 * small formatting subset and capped at Chat's 4096-character limit, with a
 * link back to the full run in Cortex.
 */
function buildChatBody(job: JobRow, result: ExecResult): string {
  const base = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  const body = [
    `**${result.ok ? '✅' : '⚠️'} ${job.name}**`,
    '',
    result.ok
      ? result.output || '(no output)'
      : `The routine failed:\n\n${result.error ?? 'Unknown error'}`,
    base ? `\n[View this routine in Cortex](${base}/schedules)` : '',
  ].join('\n');
  return toChatText(body, base ? { moreUrl: `${base}/schedules` } : {});
}

/**
 * Who should get this run as a Chat DM.
 *
 * Delivery is opt-in per person (`user_preferences.deliver_chat_dm`) and
 * ADDITIVE — it never replaces the email. An explicit recipient list wins and
 * is matched back to Cortex users by address; otherwise it is the job's owner.
 * Anyone without the preference on, without a Cortex account, or without a DM
 * space with the Chat app is simply skipped.
 */
async function chatDmUserIds(job: JobRow): Promise<string[]> {
  // Scoped to the job's workspace, so an explicit recipient list can only ever
  // match colleagues: an address belonging to somebody at another company
  // resolves to no directory row and is silently skipped.
  const db = getOrgScopedClient(job.organization_id);
  let candidates: string[];

  if (job.recipients.length > 0) {
    const { data } = await db
      .from('users')
      .select('id')
      .in(
        'email',
        job.recipients.map((r) => r.trim().toLowerCase()),
      );
    candidates = ((data ?? []) as Array<{ id: string }>).map((u) => u.id);
  } else {
    candidates = [job.user_id];
  }
  if (candidates.length === 0) return [];

  const { data: prefs } = await db
    .from('user_preferences')
    .select('user_id')
    .in('user_id', candidates)
    .eq('deliver_chat_dm', true);
  return ((prefs ?? []) as Array<{ user_id: string }>).map((p) => p.user_id);
}

/** Run the job's fixed tool call. Never throws — errors become the result. */
async function executeToolJob(job: JobRow): Promise<ExecResult> {
  const toolDef = getTool(job.tool_id ?? '');
  if (!toolDef) return { ok: false, output: '', error: `Unknown tool: ${job.tool_id}` };
  const ctx = buildToolContext({
    organizationId: job.organization_id,
    userId: job.user_id,
    agentId: job.agent_id,
    surface: 'schedule',
  });
  try {
    const result = await runTool(toolDef, job.tool_input ?? {}, ctx, {
      confirmed: job.allow_unattended_writes,
    });
    return { ok: true, output: truncate(JSON.stringify(result, null, 2)) };
  } catch (err) {
    logger.error('scheduled tool job failed', {
      jobId: job.id,
      tool: job.tool_id,
      ...toolErrorDetail(err),
    });
    return { ok: false, output: '', error: toolErrorMessage(err) };
  }
}

/**
 * Run an unattended agent turn: same tool wiring as the chat route, but with
 * no human available — confirmation-gated tools are skipped unless the job
 * opted into unattended writes.
 */
async function executeAgentJob(job: JobRow): Promise<ExecResult> {
  const db = getOrgScopedClient(job.organization_id);
  const { data: agent, error } = await db
    .from('agents')
    .select('id, system_prompt, default_model, allowed_tool_ids')
    .eq('id', job.agent_id)
    .single();
  if (error || !agent) return { ok: false, output: '', error: `Agent ${job.agent_id} not found` };

  const ctx = buildToolContext({
    organizationId: job.organization_id,
    userId: job.user_id,
    agentId: job.agent_id,
    surface: 'schedule',
  });
  const allowed = filterTools(agent.allowed_tool_ids as string[]);

  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => [
      t.id.replaceAll('.', '_'),
      tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (args, { abortSignal }) => {
          if (t.requiresConfirmation && !job.allow_unattended_writes) {
            return {
              __skipped: true,
              tool: t.id,
              reason:
                'This tool requires human confirmation and the job does not allow unattended writes. Report this to the user instead.',
            } as unknown as never;
          }
          try {
            return await runTool(
              t,
              args,
              { ...ctx, signal: abortSignal },
              { confirmed: job.allow_unattended_writes },
            );
          } catch (err) {
            logger.error('scheduled tool failed', {
              jobId: job.id,
              tool: t.id,
              ...toolErrorDetail(err),
            });
            return {
              __error: true,
              tool: t.id,
              message: toolErrorMessage(err),
            } as unknown as never;
          }
        },
      }),
    ]),
  );

  const system = `${agent.system_prompt as string}

---
UNATTENDED SCHEDULED RUN. You are executing the scheduled job "${job.name}" with no human present:
- Do NOT ask questions or wait for confirmation — nobody will answer.
- If a tool returns __skipped (requires confirmation), note it in your report and move on.
- Finish with a single self-contained report of what you did and found, in the language of the instruction.`;

  try {
    const result = await generateText({
      model: chatModel(agent.default_model as string),
      system,
      messages: [{ role: 'user', content: job.instruction ?? '' }],
      tools: aiTools,
      toolChoice: 'auto',
      maxSteps: 12,
    });
    const text = result.text.trim();
    if (!text) return { ok: false, output: '', error: 'Agent produced no final text' };
    return { ok: true, output: truncate(text) };
  } catch (err) {
    logger.error('scheduled agent job failed', { jobId: job.id, ...toolErrorDetail(err) });
    return { ok: false, output: '', error: toolErrorMessage(err) };
  }
}

export const scheduleRun = inngest.createFunction(
  { id: 'schedule-run', concurrency: { limit: 5 } },
  { event: 'scheduled/job.run' },
  async ({ event, step }) => {
    const jobId = event.data.jobId as string;
    const scheduledFor = event.data.scheduledFor as string;
    // Put on the event by schedule-dispatch, straight off the job row. Every
    // database handle in this function is built from it, so a run can only ever
    // read and write inside the workspace that owns the routine — including the
    // load below, which finds nothing at all if the two ever disagree.
    const organizationId = event.data.organizationId as string | undefined;
    if (!organizationId) return { skipped: 'no workspace on the event' };

    const job = await step.run('load-job', async (): Promise<JobRow | null> => {
      const db = getOrgScopedClient(organizationId);
      const { data, error } = await db
        .from('scheduled_jobs')
        .select(
          'id, organization_id, user_id, agent_id, name, kind, tool_id, tool_input, instruction, schedule_kind, status, allow_unattended_writes, notify_conversation, notify_email, conversation_id, recipients, is_global, timezone, next_run_at',
        )
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load job ${jobId}: ${error.message}`);
      if (!data) return null;
      const { data: user } = await db
        .from('users')
        .select('email')
        .eq('id', data.user_id as string)
        .maybeSingle();
      return {
        ...data,
        recipients: ((data.recipients as string[] | null) ?? []).filter(Boolean),
        is_global: (data.is_global as boolean | null) ?? false,
        user_email: (user?.email as string | null) ?? null,
        timezone: (data.timezone as string | null) ?? null,
        next_run_at: (data.next_run_at as string | null) ?? null,
      } as JobRow;
    });

    // Cancelled/paused between dispatch and execution — do nothing.
    if (!job) return { skipped: 'job not found' };
    if (job.status !== 'active') return { skipped: `job is ${job.status}` };

    const runId = await step.run('create-run', async () => {
      const db = getOrgScopedClient(organizationId);
      const { data, error } = await db
        .from('scheduled_job_runs')
        .insert({
          job_id: job.id,
          status: 'running',
          metadata: { scheduledFor },
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`Failed to create run row: ${error?.message}`);
      return data.id as string;
    });

    // Execution never throws: failures are captured in the result so Inngest
    // does not retry (and possibly double-execute) side-effectful work.
    const result = await step.run('execute', async (): Promise<ExecResult> => {
      const startedAt = Date.now();
      const exec = job.kind === 'tool' ? await executeToolJob(job) : await executeAgentJob(job);
      return { ...exec, durationMs: Date.now() - startedAt };
    });

    if (job.notify_conversation) {
      await step.run('deliver-conversation', async () => {
        const db = getOrgScopedClient(organizationId);
        let conversationId = job.conversation_id;
        if (!conversationId) {
          const { data: conv, error } = await db
            .from('conversations')
            .insert({
              user_id: job.user_id,
              agent_id: job.agent_id,
              surface: 'web',
              title: `⏱ ${job.name}`.slice(0, 60),
            })
            .select('id')
            .single();
          if (error || !conv) throw new Error(`Failed to create conversation: ${error?.message}`);
          conversationId = conv.id as string;
          await db
            .from('scheduled_jobs')
            .update({ conversation_id: conversationId })
            .eq('id', job.id);
        }
        const content = result.ok
          ? `**Scheduled run — ${job.name}**\n\n${result.output}`
          : `**Scheduled run — ${job.name}** failed:\n\n${result.error}`;
        const { error: msgErr } = await db.from('messages').insert({
          conversation_id: conversationId,
          role: 'assistant',
          content,
        });
        if (msgErr) throw new Error(`Failed to insert message: ${msgErr.message}`);
        return conversationId;
      });
    }

    // Explicit recipient list wins; otherwise fall back to the job owner.
    const emailTo =
      job.recipients.length > 0 ? job.recipients : job.user_email ? [job.user_email] : [];

    if (job.notify_email && emailTo.length > 0) {
      await step.run('deliver-email', async () => {
        // Delivery is best-effort: a mail failure must never fail the run.
        try {
          const mail = renderRoutineResultEmail({
            jobId: job.id,
            jobName: job.name,
            ok: result.ok,
            outputMarkdown: result.output,
            errorMessage: result.error ?? null,
            ranAt: new Date(),
            durationMs: result.durationMs ?? null,
            nextRunAt: job.next_run_at ? new Date(job.next_run_at) : null,
            timeZone: job.timezone,
          });
          return await sendEmail({
            to: emailTo,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          });
        } catch (err) {
          logger.error('schedule-run: email delivery failed', {
            jobId: job.id,
            error: (err as Error).message,
          });
          return { sent: false, reason: (err as Error).message.slice(0, 300) };
        }
      });
    }

    // Google Chat DM — in ADDITION to the email, for people who opted in.
    // Wrapped whole so neither the preference lookup nor a Chat outage can
    // fail the run: the routine already did its work.
    const chat = await step.run('deliver-chat-dm', async () => {
      try {
        const userIds = await chatDmUserIds(job);
        if (userIds.length === 0) return { sent: 0 };
        const text = buildChatBody(job, result);
        const outcomes = await Promise.all(
          userIds.map((userId) =>
            sendChatDm({
              organizationId: job.organization_id,
              userId,
              text,
              threadKey: `job-${job.id}`,
            }),
          ),
        );
        const sent = outcomes.filter((o) => o.sent).length;
        if (sent < userIds.length) {
          logger.warn('schedule-run: some Chat DMs were not delivered', {
            jobId: job.id,
            wanted: userIds.length,
            sent,
          });
        }
        return { sent };
      } catch (err) {
        logger.error('schedule-run: Chat DM delivery failed', {
          jobId: job.id,
          error: (err as Error).message,
        });
        return { sent: 0 };
      }
    });

    await step.run('finalize', async () => {
      const db = getOrgScopedClient(organizationId);
      const { error: runErr } = await db
        .from('scheduled_job_runs')
        .update({
          status: result.ok ? 'ok' : 'error',
          finished_at: new Date().toISOString(),
          output: result.ok ? result.output : null,
          error: result.ok ? null : result.error,
        })
        .eq('id', runId);
      if (runErr) throw new Error(`Failed to finalize run: ${runErr.message}`);

      await db
        .from('scheduled_jobs')
        .update({
          last_run_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
      // One-offs are done after their single run (guarded so a cancel that
      // happened mid-run is not clobbered back to completed).
      if (job.schedule_kind === 'once') {
        await db
          .from('scheduled_jobs')
          .update({ status: 'completed' })
          .eq('id', job.id)
          .eq('status', 'active');
      }
    });

    // ── EL AVISO ──────────────────────────────────────────────────────────
    // Después de finalizar, y en su propio paso: si escribir el recado falla,
    // Inngest no reintenta la ejecución de la rutina, que ya ocurrió.
    //
    // `deliveredElsewhere` es lo que decide si una rutina que SALIÓ BIEN merece
    // un renglón. Una rutina con correo o con conversación ya llega a un sitio
    // que la persona mira, y repetirla en la campana la llenaría justo con lo
    // único que nunca hace falta leer. Una rutina sin ningún canal es lo
    // contrario: hoy corre y termina en silencio absoluto. El fallo se avisa
    // siempre, tenga el canal que tenga. Ver lib/notifications/producers.ts.
    await step.run('notify', async () => {
      const delivered =
        job.notify_conversation || (job.notify_email && emailTo.length > 0) || chat.sent > 0;
      await noteRoutineRun(getOrgScopedClient(organizationId), {
        userId: job.user_id,
        job: { id: job.id, name: job.name },
        runId,
        ok: result.ok,
        error: result.error ?? null,
        deliveredElsewhere: delivered,
      });
      return { notified: true };
    });

    return { ok: result.ok, runId };
  },
);
