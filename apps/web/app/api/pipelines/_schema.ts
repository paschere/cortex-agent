import { z } from 'zod';

/**
 * Server-side validation for the visual pipeline builder. Deliberately the
 * SAME rules as pipeline.create / pipeline.update in
 * packages/agent-tools/src/pipeline/tools.ts — the builder is just another
 * front door to the exact same data model, so a payload that passes here would
 * pass there too.
 */

export const ParamDef = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'param names are identifiers'),
  description: z.string().max(200).default(''),
  required: z.boolean().default(true),
});

export const StepDef = z.object({
  title: z.string().min(2).max(80),
  detail: z.string().min(5).max(2000),
  tools: z.array(z.string()).max(8).default([]),
  checkpoint: z.boolean().default(false),
});

/** Everything except the slug, which is create-only (immutable afterwards). */
export const PipelineBody = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).default(''),
  emoji: z.string().max(8).default('⚡'),
  intro: z.string().max(1000).default(''),
  steps: z.array(StepDef).min(1).max(12),
  params: z.array(ParamDef).max(10).default([]),
});

export const CreateBody = PipelineBody.extend({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'kebab-case, 2-49 chars'),
});

/** PATCH accepts either a full edit or a bare archive toggle. */
export const UpdateBody = z.union([
  PipelineBody.extend({ archived: z.boolean().optional() }),
  z.object({ archived: z.boolean() }).strict(),
]);

export type ParamDefT = z.infer<typeof ParamDef>;
export type StepDefT = z.infer<typeof StepDef>;

/**
 * Mirrors validatePlaceholders() in the pipeline tools: every {{placeholder}}
 * used in the intro or in a step title/detail must be a declared param.
 * Returns an error message, or null when the payload is coherent.
 */
export function placeholderError(
  intro: string,
  steps: StepDefT[],
  params: Array<{ name: string }>,
): string | null {
  const re = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
  const texts = [intro, ...steps.flatMap((s) => [s.title, s.detail])];
  const used = texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[1] as string));
  const declared = new Set(params.map((p) => p.name));
  const undeclared = [...new Set(used.filter((p) => !declared.has(p)))];
  if (undeclared.length > 0) {
    return `Steps use undeclared params: ${undeclared.join(', ')}. Declare them in params.`;
  }
  const names = params.map((p) => p.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length > 0) {
    return `Duplicate param names: ${dupes.join(', ')}.`;
  }
  return null;
}
