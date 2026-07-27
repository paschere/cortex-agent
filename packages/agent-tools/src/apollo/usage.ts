import { z } from 'zod';
import { registerTool } from '../index';
import { apolloFetch } from './client';
import { DATASET, OK_STATUS, failureStatus, sourceOf, sourceSchema, statusShape } from './shape';

/**
 * Apollo account usage — POST /api/v1/usage_stats/api_usage_stats.
 *
 * The only free tool in this family, and the one that explains the others when
 * they stop working. Apollo caps how many lookups an account may make per
 * minute, hour and day, quite separately from the credit balance; when a lookup
 * comes back rate-limited, this is what turns "Apollo said no" into "we have
 * used 600 person lookups today and get more at midnight".
 *
 * IMPORTANT, and stated in the description so nobody is misled: Apollo does not
 * publish the remaining CREDIT balance through the API. This reports allowances
 * on the NUMBER of lookups only. Claiming otherwise would be exactly the kind
 * of confident wrong answer that costs somebody money.
 */

/**
 * Apollo keys the response by an internal route, e.g. `["api/v1/people",
 * "match"]`. Those are not words to show anyone, so each is translated to a
 * plain description of the work and anything unrecognised is dropped rather
 * than leaked. Order matters: the bulk variants must be tested before the
 * single-record ones, whose routes are substrings of theirs.
 */
const OPERATION_LABELS: Array<[RegExp, string]> = [
  [/mixed_people/, 'Searching for people'],
  [/people.*bulk_match/, 'Looking up a batch of people'],
  [/people.*match/, 'Looking up one person'],
  [/mixed_companies/, 'Searching for companies'],
  [/organizations.*bulk_enrich/, 'Looking up a batch of companies'],
  [/organizations.*enrich/, 'Looking up one company'],
  [/job_posting/, 'Reading the roles a company has open'],
  [/news_article/, 'Reading company news'],
];

function labelFor(route: string): string | null {
  for (const [re, label] of OPERATION_LABELS) if (re.test(route)) return label;
  return null;
}

interface RawWindow {
  limit?: number | null;
  consumed?: number | null;
  left_over?: number | null;
}

interface RawUsage {
  day?: RawWindow | null;
  hour?: RawWindow | null;
  minute?: RawWindow | null;
}

const usageSchema = z.object({
  operation: z.string(),
  usedToday: z.number(),
  allowedToday: z.number(),
  leftToday: z.number(),
  leftThisHour: z.number(),
  leftThisMinute: z.number(),
});

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const apolloAccountUsage = registerTool({
  id: 'apollo.remaining_lookups',
  description:
    'Check how many Apollo lookups this workspace has already made today and how many are left before Apollo starts turning them down. Free to run — it spends no Apollo credits. Use it when Apollo says it is rate-limiting us, or before planning a lot of lookups in one sitting. Note this is the allowance on the NUMBER of lookups; Apollo does not publish the remaining credit balance, so it cannot answer "how many credits are left".',
  inputSchema: z.object({}),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    operations: z.array(usageSchema),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (_input, ctx) => {
    const base = { source: sourceOf(DATASET.accountUsage), operations: [], guidance: '' };

    const res = await apolloFetch<Record<string, RawUsage>>(
      ctx,
      'POST',
      '/usage_stats/api_usage_stats',
    );
    if (!res.ok) return { ...base, ...failureStatus(res) };

    // Several routes can map to the same human operation; keep the busiest one
    // so the answer describes the constraint people will actually hit.
    const byOperation = new Map<string, z.infer<typeof usageSchema>>();
    for (const [route, windows] of Object.entries(res.data ?? {})) {
      const operation = labelFor(route);
      if (!operation || !windows) continue;
      const row = {
        operation,
        usedToday: n(windows.day?.consumed),
        allowedToday: n(windows.day?.limit),
        leftToday: n(windows.day?.left_over),
        leftThisHour: n(windows.hour?.left_over),
        leftThisMinute: n(windows.minute?.left_over),
      };
      const existing = byOperation.get(operation);
      if (!existing || row.usedToday > existing.usedToday) byOperation.set(operation, row);
    }

    const operations = [...byOperation.values()].sort((a, b) => b.usedToday - a.usedToday);

    const exhausted = operations.filter((o) => o.allowedToday > 0 && o.leftToday <= 0);
    const tight = operations.filter(
      (o) => o.allowedToday > 0 && o.leftToday > 0 && o.leftToday <= o.allowedToday * 0.1,
    );

    return {
      ...OK_STATUS,
      ...base,
      operations,
      guidance: !operations.length
        ? 'Apollo did not report any usage for this workspace, which normally just means nothing has been looked up recently.'
        : exhausted.length
          ? `Today's allowance is used up for: ${exhausted.map((o) => o.operation.toLowerCase()).join(', ')}. Those start working again tomorrow; everything else still has room.`
          : tight.length
            ? `Running low today on: ${tight.map((o) => o.operation.toLowerCase()).join(', ')}. Worth being selective with those until tomorrow.`
            : 'There is plenty of room left on every kind of lookup today. Remember this counts lookups, not money — the credit balance is a separate thing only visible inside Apollo.',
    };
  },
});
