import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';

/**
 * Pipelines (playbooks): reusable flows the agent designs once — as
 * STRUCTURED STEPS with {{param}} placeholders — and anyone invokes later as
 * a single call, from any surface (web chat, claude.ai, Claude Code, cron).
 *
 * Execution model: pipeline.run renders the steps with the provided args and
 * returns the active playbook. The CALLING model executes the steps with its
 * normal tools, so every step still flows through runTool — audit trail and
 * confirmation gates included. Checkpoint steps are hard stops: present
 * findings and wait for the user's decision. When done, the model reports
 * the outcome with pipeline.finish_run, which closes the run-log entry.
 *
 * Scheduling: schedule.create kind=agent with instruction
 * 'Run the pipeline "<slug>" with ...' gives any pipeline a cron cadence.
 */

const ParamDef = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'param names are identifiers'),
  description: z.string().default(''),
  required: z.boolean().default(true),
});

const StepDef = z.object({
  title: z.string().min(2).max(80).describe('Short imperative label, e.g. "Sweep job boards"'),
  detail: z
    .string()
    .min(5)
    .max(2000)
    .describe(
      'What to do in this step: tools to call, what to look for, what to produce. May use {{param}}.',
    ),
  tools: z
    .array(z.string())
    .max(8)
    .default([])
    .describe(
      'Tool ids this step uses, e.g. ["growth.find_signals", "kb.search"] — shown as chips in the UI',
    ),
  checkpoint: z
    .boolean()
    .default(false)
    .describe(
      'true = human decision point: present findings and WAIT for the user before continuing',
    ),
});

const PipelineSummary = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  emoji: z.string(),
  params: z.array(ParamDef),
  stepCount: z.number(),
  checkpointCount: z.number(),
  timesRun: z.number(),
  lastRunAt: z.string().nullable(),
});

type Step = z.infer<typeof StepDef>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSummary(r: Record<string, any>): z.infer<typeof PipelineSummary> {
  const steps = (r.steps ?? []) as Step[];
  return {
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    emoji: r.emoji ?? '⚡',
    params: (r.params ?? []) as z.infer<typeof ParamDef>[],
    stepCount: steps.length,
    checkpointCount: steps.filter((s) => s.checkpoint).length,
    timesRun: r.times_run ?? 0,
    lastRunAt: r.last_run_at ?? null,
  };
}

function validatePlaceholders(texts: string[], params: Array<{ name: string }>): void {
  const placeholders = texts
    .flatMap((t) => [...t.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)])
    .map((m) => m[1] as string);
  const declared = new Set(params.map((p) => p.name));
  const undeclared = [...new Set(placeholders.filter((p) => !declared.has(p)))];
  if (undeclared.length > 0) {
    throw new ValidationError(
      `Steps use undeclared params: ${undeclared.join(', ')}. Declare them in params.`,
    );
  }
}

function render(text: string, args: Record<string, string>): string {
  return text.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g,
    (_, p: string) => args[p] ?? `{{${p}}}`,
  );
}

export const pipelineCreate = registerTool({
  id: 'pipeline.create',
  description:
    'Save a reusable pipeline (playbook): a named, parameterized flow of STRUCTURED STEPS that reference available tools. Design guidance: 3-8 steps, each with a short title and a concrete detail naming the tools to use; mark human decision points with checkpoint=true (present findings, wait for approval) — good pipelines put a checkpoint before any external side effect (sending, posting, moving stages). Use {{paramName}} placeholders and declare each in params. Once created, anyone runs it with pipeline.run from any surface, and schedule.create can put it on a cadence. Confirmation-gated: show the user the full step list before saving.',
  inputSchema: z.object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'kebab-case, 2-49 chars')
      .describe('Stable identifier, e.g. "weekly-client-report"'),
    name: z.string().min(2).max(80),
    description: z.string().max(300).default(''),
    emoji: z.string().max(8).default('⚡').describe('One emoji for the gallery card'),
    intro: z.string().max(1000).default('').describe('Optional context shown before step 1'),
    steps: z.array(StepDef).min(1).max(12),
    params: z.array(ParamDef).max(10).default([]),
  }),
  outputSchema: z.object({ pipeline: PipelineSummary }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    validatePlaceholders(
      [input.intro ?? '', ...input.steps.flatMap((s) => [s.title, s.detail])],
      input.params ?? [],
    );

    const { data, error } = await ctx.db
      .from('pipelines')
      .insert({
        slug: input.slug,
        name: input.name,
        description: input.description ?? '',
        emoji: input.emoji ?? '⚡',
        intro: input.intro ?? '',
        steps: input.steps,
        instruction: '', // legacy column; superseded by steps
        params: input.params ?? [],
        created_by: ctx.userId,
      })
      .select('*')
      .single();
    if (error) {
      throw new ValidationError(
        error.code === '23505'
          ? `Pipeline "${input.slug}" already exists — pick another slug or update it.`
          : error.message,
      );
    }
    return { pipeline: toSummary(data) };
  },
});

export const pipelineList = registerTool({
  id: 'pipeline.list',
  description:
    'List saved pipelines (playbooks) with their parameters, step counts, and run counts. Check here before creating a new one — a similar pipeline may already exist.',
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
  description: 'Get one pipeline by slug, including its full step list and intro.',
  inputSchema: z.object({ slug: z.string().min(1) }),
  outputSchema: z.object({
    pipeline: PipelineSummary.extend({
      intro: z.string(),
      steps: z.array(StepDef),
      archived: z.boolean(),
    }),
  }),
  handler: async (input, ctx) => {
    const { data, error } = await ctx.db
      .from('pipelines')
      .select('*')
      .eq('slug', input.slug)
      .maybeSingle();
    if (error || !data) throw new ValidationError(`Pipeline not found: ${input.slug}`);
    return {
      pipeline: {
        ...toSummary(data),
        intro: (data.intro as string) ?? '',
        steps: ((data.steps ?? []) as Step[]).map((s) => ({
          ...s,
          tools: s.tools ?? [],
          checkpoint: s.checkpoint ?? false,
        })),
        archived: Boolean(data.archived),
      },
    };
  },
});

export const pipelineUpdate = registerTool({
  id: 'pipeline.update',
  description:
    'Update a pipeline: change its name, description, emoji, intro, steps, params, or archive it. Confirmation-gated — show the user what changes before saving.',
  inputSchema: z.object({
    slug: z.string().min(1),
    name: z.string().min(2).max(80).optional(),
    description: z.string().max(300).optional(),
    emoji: z.string().max(8).optional(),
    intro: z.string().max(1000).optional(),
    steps: z.array(StepDef).min(1).max(12).optional(),
    params: z.array(ParamDef).max(10).optional(),
    archived: z.boolean().optional(),
  }),
  outputSchema: z.object({ pipeline: PipelineSummary }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    if (input.steps || input.intro !== undefined) {
      // Validate placeholders against the params that will be in effect.
      const { data: existing } = await ctx.db
        .from('pipelines')
        .select('steps, intro, params')
        .eq('slug', input.slug)
        .maybeSingle();
      if (!existing) throw new ValidationError(`Pipeline not found: ${input.slug}`);
      const steps = input.steps ?? (existing.steps as Step[]) ?? [];
      const intro = input.intro ?? ((existing.intro as string) || '');
      const params = input.params ?? ((existing.params ?? []) as Array<{ name: string }>);
      validatePlaceholders([intro, ...steps.flatMap((s) => [s.title, s.detail])], params);
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.emoji !== undefined) patch.emoji = input.emoji;
    if (input.intro !== undefined) patch.intro = input.intro;
    if (input.steps !== undefined) patch.steps = input.steps;
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
    'Load a saved pipeline for execution: renders its steps with the provided args, opens a run-log entry, and returns the active playbook. Execute it step by step with your available tools; checkpoint steps are HARD STOPS (present findings, wait for the user). When finished, call pipeline.finish_run with the runId and a one-line summary. Ask the user for any missing required args before calling.',
  inputSchema: z.object({
    slug: z.string().min(1),
    args: z.record(z.string()).default({}),
  }),
  outputSchema: z.object({
    name: z.string(),
    runId: z.string(),
    runNumber: z.number(),
    playbook: z.string(),
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
    const missing = params
      .filter((p) => p.required !== false && !(p.name in args))
      .map((p) => p.name);
    if (missing.length > 0) {
      throw new ValidationError(
        `Missing required args: ${missing.join(', ')}. Ask the user, then call pipeline.run again.`,
      );
    }

    const steps = (data.steps ?? []) as Step[];
    const intro = render((data.intro as string) ?? '', args);
    // Legacy pipelines (pre-steps) carry the flow in `instruction`.
    const legacy = steps.length === 0 ? render((data.instruction as string) ?? '', args) : '';

    const timesRun = ((data.times_run as number) ?? 0) + 1;
    await ctx.db
      .from('pipelines')
      .update({ times_run: timesRun, last_run_at: new Date().toISOString() })
      .eq('id', data.id as string);
    const { data: run } = await ctx.db
      .from('pipeline_runs')
      .insert({ pipeline_id: data.id as string, run_by: ctx.userId, args })
      .select('id')
      .single();

    const renderedSteps = steps
      .map((s, i) => {
        const head = s.checkpoint
          ? `⛔ STEP ${i + 1} — CHECKPOINT: ${render(s.title, args)}`
          : `▪ STEP ${i + 1}: ${render(s.title, args)}`;
        const toolsLine =
          (s.tools ?? []).length > 0 ? `\n   Tools: ${(s.tools ?? []).join(', ')}` : '';
        const gate = s.checkpoint
          ? "\n   HARD STOP: present your findings and WAIT for the user's explicit decision before continuing."
          : '';
        return `${head}\n   ${render(s.detail, args)}${toolsLine}${gate}`;
      })
      .join('\n\n');

    return {
      name: data.name as string,
      runId: (run?.id as string) ?? '',
      runNumber: timesRun,
      playbook:
        `${(data.emoji as string) ?? '⚡'} PIPELINE: ${data.name} (run #${timesRun})\n\n` +
        (intro ? `${intro}\n\n` : '') +
        (legacy || renderedSteps) +
        `\n\nExecute now, step by step, reporting progress after each step. ` +
        `Confirmation-gated tools still require approval. When finished (or if the user abandons), call pipeline.finish_run with runId="${(run?.id as string) ?? ''}" and a one-line outcome summary.`,
    };
  },
});

export const pipelineFinishRun = registerTool({
  id: 'pipeline.finish_run',
  description:
    'Close a pipeline run started by pipeline.run: record whether it completed or was abandoned, with a one-line outcome summary (numbers over adjectives). This feeds the run history on the /pipelines page.',
  inputSchema: z.object({
    runId: z.string().uuid(),
    status: z.enum(['completed', 'abandoned']).default('completed'),
    summary: z.string().min(3).max(500),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async (input, ctx) => {
    const { error } = await ctx.db
      .from('pipeline_runs')
      .update({
        status: input.status,
        summary: input.summary,
        finished_at: new Date().toISOString(),
      })
      .eq('id', input.runId);
    if (error) throw new ValidationError(`Run not found: ${input.runId}`);
    return { ok: true };
  },
});
