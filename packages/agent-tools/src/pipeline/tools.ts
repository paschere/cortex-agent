import { ValidationError } from '@zipdev/core';
import { z } from 'zod';
import { registerTool } from '../index';

/**
 * Pipelines (playbooks): reusable flows the agent defines once — in natural
 * language, with {{param}} placeholders — and anyone invokes later as a
 * single call, from any surface (web chat, claude.ai, Claude Code, cron).
 *
 * Execution model: pipeline.run renders the instruction with the provided
 * args and returns it as the active playbook. The CALLING model executes the
 * steps with its normal tools, so every step still flows through runTool —
 * audit trail and confirmation gates included. This keeps pipelines
 * model-agnostic (Gemini web chat and Claude via MCP run the same playbook).
 *
 * Scheduling: schedule.create kind=agent with instruction
 * 'Run the pipeline "<slug>" with ...' gives any pipeline a cron cadence.
 */

const ParamDef = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'param names are identifiers'),
  description: z.string().default(''),
  required: z.boolean().default(true),
});

const PipelineSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  params: z.array(ParamDef),
  timesRun: z.number(),
  lastRunAt: z.string().nullable(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSummary(r: Record<string, any>): z.infer<typeof PipelineSummary> {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    params: (r.params ?? []) as z.infer<typeof ParamDef>[],
    timesRun: r.times_run ?? 0,
    lastRunAt: r.last_run_at ?? null,
  };
}

export const pipelineCreate = registerTool({
  id: 'pipeline.create',
  description:
    'Save a reusable pipeline (playbook): a named, parameterized flow written as step-by-step natural-language instructions that reference available tools. Use {{paramName}} placeholders in the instruction and declare each one in params. Once created, anyone can run it with pipeline.run from any surface, and it can be scheduled with schedule.create. Confirmation-gated: show the user the full pipeline before saving.',
  inputSchema: z.object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'kebab-case, 2-49 chars')
      .describe('Stable identifier, e.g. "weekly-client-report"'),
    name: z.string().min(2).max(80),
    description: z.string().max(300).default(''),
    instruction: z
      .string()
      .min(20)
      .max(8000)
      .describe(
        'The playbook body: numbered steps in natural language, naming the tools to use and the checkpoints where the user must confirm. Use {{param}} placeholders.',
      ),
    params: z.array(ParamDef).max(10).default([]),
  }),
  outputSchema: z.object({ pipeline: PipelineSummary }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    // Every {{placeholder}} must be declared (catches typos at save time).
    const placeholders = [...input.instruction.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map(
      (m) => m[1] as string,
    );
    const declared = new Set((input.params ?? []).map((p) => p.name));
    const undeclared = placeholders.filter((p) => !declared.has(p));
    if (undeclared.length > 0) {
      throw new ValidationError(
        `Instruction uses undeclared params: ${[...new Set(undeclared)].join(', ')}. Declare them in params.`,
      );
    }

    const { data, error } = await ctx.db
      .from('pipelines')
      .insert({
        slug: input.slug,
        name: input.name,
        description: input.description ?? '',
        instruction: input.instruction,
        params: input.params ?? [],
        created_by: ctx.userId,
      })
      .select('*')
      .single();
    if (error) {
      throw new ValidationError(
        error.code === '23505' ? `Pipeline "${input.slug}" already exists — pick another slug or update it.` : error.message,
      );
    }
    return { pipeline: toSummary(data) };
  },
});

export const pipelineList = registerTool({
  id: 'pipeline.list',
  description:
    'List saved pipelines (playbooks) with their parameters and run counts. Check here before creating a new one — a similar pipeline may already exist.',
  inputSchema: z.object({
    includeArchived: z.boolean().default(false),
  }),
  outputSchema: z.object({ pipelines: z.array(PipelineSummary) }),
  handler: async (input, ctx) => {
    let q = ctx.db.from('pipelines').select('*').order('times_run', { ascending: false });
    if (!input.includeArchived) q = q.eq('archived', false);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { pipelines: (data ?? []).map(toSummary) };
  },
});

export const pipelineGet = registerTool({
  id: 'pipeline.get',
  description: 'Get one pipeline by slug, including its full instruction body.',
  inputSchema: z.object({ slug: z.string().min(1) }),
  outputSchema: z.object({
    pipeline: PipelineSummary.extend({ instruction: z.string(), archived: z.boolean() }),
  }),
  handler: async (input, ctx) => {
    const { data, error } = await ctx.db
      .from('pipelines')
      .select('*')
      .eq('slug', input.slug)
      .maybeSingle();
    if (error || !data) throw new ValidationError(`Pipeline not found: ${input.slug}`);
    return {
      pipeline: { ...toSummary(data), instruction: data.instruction as string, archived: Boolean(data.archived) },
    };
  },
});

export const pipelineUpdate = registerTool({
  id: 'pipeline.update',
  description:
    'Update a pipeline: change its name, description, instruction, params, or archive it. Confirmation-gated — show the user the diff before saving.',
  inputSchema: z.object({
    slug: z.string().min(1),
    name: z.string().min(2).max(80).optional(),
    description: z.string().max(300).optional(),
    instruction: z.string().min(20).max(8000).optional(),
    params: z.array(ParamDef).max(10).optional(),
    archived: z.boolean().optional(),
  }),
  outputSchema: z.object({ pipeline: PipelineSummary }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.instruction !== undefined) patch.instruction = input.instruction;
    if (input.params !== undefined) patch.params = input.params;
    if (input.archived !== undefined) patch.archived = input.archived;

    const { data, error } = await ctx.db
      .from('pipelines')
      .update(patch)
      .eq('slug', input.slug)
      .select('*')
      .single();
    if (error || !data) throw new ValidationError(`Pipeline not found: ${input.slug}`);
    return { pipeline: toSummary(data) };
  },
});

export const pipelineRun = registerTool({
  id: 'pipeline.run',
  description:
    'Load a saved pipeline for execution: renders its instruction with the provided args and returns the active playbook. Follow the returned playbook step by step using your available tools — write steps remain confirmation-gated as usual. Ask the user for any missing required args before calling.',
  inputSchema: z.object({
    slug: z.string().min(1),
    args: z.record(z.string()).default({}),
  }),
  outputSchema: z.object({
    name: z.string(),
    playbook: z.string(),
    runNumber: z.number(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const { data, error } = await ctx.db
      .from('pipelines')
      .select('*')
      .eq('slug', input.slug)
      .eq('archived', false)
      .maybeSingle();
    if (error || !data) throw new ValidationError(`Pipeline not found: ${input.slug}`);

    const params = (data.params ?? []) as Array<{ name: string; required?: boolean }>;
    const args = input.args ?? {};
    const missing = params.filter((p) => p.required !== false && !(p.name in args)).map((p) => p.name);
    if (missing.length > 0) {
      throw new ValidationError(
        `Missing required args: ${missing.join(', ')}. Ask the user, then call pipeline.run again.`,
      );
    }

    const rendered = (data.instruction as string).replace(
      /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g,
      (_, p: string) => args[p] ?? `{{${p}}}`,
    );

    const timesRun = ((data.times_run as number) ?? 0) + 1;
    await ctx.db
      .from('pipelines')
      .update({ times_run: timesRun, last_run_at: new Date().toISOString() })
      .eq('id', data.id as string);

    return {
      name: data.name as string,
      runNumber: timesRun,
      playbook:
        `▶️ PIPELINE: ${data.name} (run #${timesRun})\n\n` +
        `Execute the following playbook now, step by step, using your available tools. ` +
        `Report progress after each step. Confirmation-gated steps still require the user's explicit approval.\n\n` +
        rendered,
    };
  },
});
