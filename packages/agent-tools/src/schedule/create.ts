import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { getTool, registerTool } from '../index';
import { computeNextRun } from './recurrence';

/**
 * Create a scheduled job from chat. The job runs unattended (dispatched by an
 * Inngest cron — see apps/web/inngest/functions/schedule-dispatch.ts) either
 * once at a fixed time or repeatedly on a cron expression, and executes either
 * a fixed tool call or a full agent turn from a natural-language instruction.
 *
 * Confirmation-gated: creating an unattended job is itself a side effect the
 * user must approve in chat.
 */
export const scheduleCreate = registerTool({
  id: 'schedule.create',
  description:
    'Create a scheduled job that runs unattended: once at a specific time (scheduleKind "once" + runAt) or repeatedly on a cron expression (scheduleKind "cron" + cron, e.g. "0 9 * * *" for every day at 09:00 in the given timezone). kind "tool" runs one fixed tool with fixed arguments; kind "agent" runs a full agent turn from a natural-language instruction and can call several tools. Tools that require confirmation only run if allowUnattendedWrites is true — ask the user before setting it. Results are posted to a dedicated conversation and optionally emailed.',
  inputSchema: z.object({
    name: z.string().min(1).max(120).describe('Short human-readable job name'),
    kind: z.enum(['tool', 'agent']),
    toolId: z
      .string()
      .optional()
      .describe('kind=tool: the tool id to run, e.g. "github.repo_activity"'),
    toolInput: z
      .record(z.unknown())
      .optional()
      .describe('kind=tool: the exact arguments for the tool'),
    instruction: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('kind=agent: natural-language instruction for the unattended agent turn'),
    scheduleKind: z.enum(['once', 'cron']),
    runAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('scheduleKind=once: ISO timestamp'),
    cron: z.string().optional().describe('scheduleKind=cron: 5-field cron expression'),
    timezone: z
      .string()
      .default('UTC')
      .describe('IANA timezone the cron expression is evaluated in'),
    allowUnattendedWrites: z
      .boolean()
      .default(false)
      .describe('Allow confirmation-gated (write) tools to run without a human confirming'),
    notifyConversation: z.boolean().default(true),
    notifyEmail: z.boolean().default(false),
  }),
  outputSchema: z.object({
    jobId: z.string(),
    name: z.string(),
    nextRunAt: z.string().nullable(),
    status: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // ToolDef infers zod's *input* type, so .default()ed fields arrive optional.
    const timezone = input.timezone ?? 'UTC';
    const allowUnattendedWrites = input.allowUnattendedWrites ?? false;

    // Cross-field validation (zod can't express these as a flat object schema).
    let nextRunAt: Date;
    if (input.scheduleKind === 'once') {
      if (!input.runAt) throw new ValidationError('scheduleKind "once" requires runAt');
      nextRunAt = new Date(input.runAt);
      if (nextRunAt.getTime() <= Date.now()) {
        throw new ValidationError(`runAt must be in the future (got ${input.runAt})`);
      }
    } else {
      if (!input.cron) throw new ValidationError('scheduleKind "cron" requires cron');
      nextRunAt = computeNextRun(input.cron, timezone); // throws on bad cron/tz
    }

    if (input.kind === 'tool') {
      if (!input.toolId || !input.toolInput) {
        throw new ValidationError('kind "tool" requires toolId and toolInput');
      }
      const tool = getTool(input.toolId);
      if (!tool) throw new ValidationError(`Unknown tool: ${input.toolId}`);
      const parsed = tool.inputSchema.safeParse(input.toolInput);
      if (!parsed.success) {
        throw new ValidationError(
          `toolInput is not valid for ${input.toolId}`,
          parsed.error.flatten(),
        );
      }
      if (tool.requiresConfirmation && !allowUnattendedWrites) {
        throw new ValidationError(
          `${input.toolId} requires confirmation and cannot run unattended. Re-create the job with allowUnattendedWrites: true (ask the user first).`,
        );
      }
    } else if (!input.instruction) {
      throw new ValidationError('kind "agent" requires instruction');
    }

    const { data, error } = await ctx.db
      .from('scheduled_jobs')
      .insert({
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        name: input.name,
        kind: input.kind,
        tool_id: input.kind === 'tool' ? input.toolId : null,
        tool_input: input.kind === 'tool' ? input.toolInput : null,
        instruction: input.kind === 'agent' ? input.instruction : null,
        schedule_kind: input.scheduleKind,
        cron: input.scheduleKind === 'cron' ? input.cron : null,
        timezone,
        run_at: input.scheduleKind === 'once' ? input.runAt : null,
        next_run_at: nextRunAt.toISOString(),
        allow_unattended_writes: allowUnattendedWrites,
        notify_conversation: input.notifyConversation ?? true,
        notify_email: input.notifyEmail ?? false,
      })
      .select('id, name, next_run_at, status')
      .single();
    if (error || !data) throw new Error(`Failed to create scheduled job: ${error?.message}`);

    return {
      jobId: data.id as string,
      name: data.name as string,
      nextRunAt: (data.next_run_at as string | null) ?? null,
      status: data.status as string,
    };
  },
});
