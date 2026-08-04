import { z } from 'zod';
import { BASE } from './matcher';

/**
 * Provenance shaping for the `presentations.*` tools.
 *
 * Every presentation tool returns `meta` — where the data came from, when it
 * was read, and what about it is untrustworthy. Cortex quotes these numbers to
 * whoever is about to send a document to a client, so "four people on that
 * role" has to be traceable to a system and a timestamp, and AI-derived scores
 * must never be passed off as ATS facts.
 *
 * This module used to live in the `recruit.*` family and served it too. That
 * family was retired when the product narrowed; the helpers moved here with
 * their surviving caller, minus the requisition/candidate projections that only
 * the retired tools ever used.
 */

/** Real systems behind the matcher's data. Never invent a label. */
export const SOURCE = {
  matcher: 'Matcher service DB',
  aiScoring: 'Cortex AI scoring',
  interviewAnalysis: 'Interview analysis (AI)',
  recruiterRatings: 'Recruiter ratings (human)',
} as const;

export const metaSchema = z
  .object({
    fetchedAt: z.string(),
    source: z.any(),
    dataQuality: z.array(z.string()),
  })
  .passthrough();

export type ToolMeta = z.infer<typeof metaSchema>;

export interface MetaInput {
  endpoint: string;
  /** True when we had to use the fat public endpoint instead of the lean one. */
  degraded?: boolean;
  degradedReason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Build a `meta` block for a tool response. */
export function buildMeta(input: MetaInput): ToolMeta {
  const { endpoint, degraded, degradedReason, ...rest } = input;
  const dataQuality: string[] = Array.isArray(rest.dataQuality) ? [...rest.dataQuality] : [];
  if (degraded) {
    dataQuality.unshift(
      `Served from the matcher's legacy public endpoint (${degradedReason ?? 'lean endpoint unavailable'}); ` +
        'pipeline status, stage breakdowns and last-activity timestamps may be missing or approximate.',
    );
  }
  return {
    fetchedAt: new Date().toISOString(),
    source: {
      system: 'Matcher service',
      baseUrl: BASE(),
      endpoint,
      mode: degraded ? 'legacy-public-endpoint' : 'lean-internal-endpoint',
    },
    ...rest,
    dataQuality,
  } as ToolMeta;
}

/**
 * Merge the matcher's own `meta` (it already carries provenance, cache state
 * and data-quality notes) with the tool-side framing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function metaFromServer(serverMeta: any, endpoint: string): ToolMeta {
  return {
    ...(serverMeta ?? {}),
    fetchedAt: serverMeta?.fetchedAt ?? new Date().toISOString(),
    source: {
      ...(serverMeta?.source ?? {}),
      baseUrl: BASE(),
      endpoint: serverMeta?.source?.endpoint ?? endpoint,
      mode: 'lean-internal-endpoint',
    },
    dataQuality: Array.isArray(serverMeta?.dataQuality) ? serverMeta.dataQuality : [],
  } as ToolMeta;
}

/**
 * One-line provenance footer for a tool's markdown, so the model has the
 * citation right next to the numbers it is about to read out loud.
 */
export function provenanceFooter(meta: ToolMeta): string {
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = meta as any;
  const bits: string[] = [];
  bits.push(`source: ${m.source?.system ?? 'Matcher service'} (${m.source?.endpoint ?? 'n/a'})`);
  bits.push(`read ${meta.fetchedAt}`);
  if (m.cache?.hit) bits.push(`cached ${m.cache.ageSeconds ?? 0}s ago`);
  if (typeof m.totalAvailable === 'number' && typeof m.returned === 'number') {
    bits.push(`showing ${m.returned} of ${m.totalAvailable}`);
  }
  lines.push(`_${bits.join(' · ')}_`);
  if (m.truncated) {
    lines.push(
      `_More records exist — re-run with offset=${(m.offset ?? 0) + (m.returned ?? 0)} to continue._`,
    );
  }
  for (const note of meta.dataQuality ?? []) lines.push(`> ⚠️ ${note}`);
  return lines.join('\n');
}

export function matcherLink(path: string): string {
  return `${BASE().replace(/\/$/, '')}${path}`;
}
