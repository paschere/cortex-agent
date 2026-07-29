import { z } from 'zod';
import { registerTool } from '../index';
import { bambooFetch } from './client';
import { fetchReport } from './roster';
import {
  DATASET,
  OK_STATUS,
  type ReportRow,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from './shape';

/**
 * What has moved in BambooHR lately.
 *
 * The changed-employees feed is what a sync job uses, and on its own it returns
 * nothing but ids and timestamps — useless to a person. So it is joined against
 * the roster here to say WHO changed and what they do, which turns it into an
 * answerable question: "who joined this month?", "did anything change on the
 * roster this week?".
 *
 * BambooHR reports THAT a record changed, never WHICH field, so nothing here
 * claims to know what was edited — including whether a rate moved.
 */

interface RawChanged {
  latest?: string | null;
  employees?: Record<string, { id?: string; action?: string; lastChanged?: string }>;
}

const changeSchema = z.object({
  name: z.string().nullable(),
  jobTitle: z.string().nullable(),
  client: z.string().nullable(),
  division: z.string().nullable(),
  status: z.string().nullable(),
  /** Inserted, Updated or Deleted, as BambooHR reports it. */
  change: z.string().nullable(),
  changedAt: z.string().nullable(),
});

const MAX_DAYS = 180;

export const bambooRecentlyChanged = registerTool({
  id: 'bamboo.recently_changed',
  description:
    'List the people whose BambooHR record changed recently — new joiners, updated records and deleted ones — with their name, role and client. Use it for "who joined this month?", "what changed on the roster this week?" or to catch up after time away. BambooHR reports that a record changed but not which field, so this cannot say what was edited.',
  inputSchema: z.object({
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_DAYS)
      .default(7)
      .describe('How far back to look, in days'),
    change: z
      .enum(['inserted', 'updated', 'deleted', 'any'])
      .default('any')
      .describe('"inserted" is the closest thing to a list of new joiners'),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    changes: z.array(changeSchema),
    totalChanged: z.number(),
    since: z.string(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const days = input.sinceDays ?? 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const empty = {
      source: sourceOf(DATASET.changed),
      changes: [] as z.infer<typeof changeSchema>[],
      totalChanged: 0,
      since,
      guidance: '',
    };

    const wanted = input.change ?? 'any';
    const res = await bambooFetch<RawChanged>(ctx, 'GET', '/employees/changed', {
      params: { since, type: wanted === 'any' ? undefined : wanted },
    });
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const entries = Object.entries(res.data?.employees ?? {});
    if (!entries.length) {
      return {
        ...OK_STATUS,
        ...empty,
        guidance: `Nothing in BambooHR changed in the last ${days} day${days === 1 ? '' : 's'}.`,
      };
    }

    // The delta feed carries no names, so the roster supplies them. `any` is
    // requested once rather than per-employee.
    const rosterRes = await fetchReport(ctx, [
      'id',
      'displayName',
      'jobTitle',
      'department',
      'division',
      'status',
    ]);
    const byId = new Map<string, ReportRow>();
    if (rosterRes.ok) for (const row of rosterRes.data) byId.set(String(row.id), row);

    const changes = entries
      .map(([id, e]) => {
        const row = byId.get(id);
        return {
          name: row ? str(row.displayName) : null,
          jobTitle: row ? str(row.jobTitle) : null,
          client: row ? str(row.department) : null,
          division: row ? str(row.division) : null,
          status: row ? str(row.status) : null,
          change: str(e?.action),
          changedAt: str(e?.lastChanged),
        };
      })
      .sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? ''));

    const limited = changes.slice(0, input.limit ?? 50);
    const unnamed = limited.filter((c) => !c.name).length;

    const notes = [
      `${changes.length} record${changes.length === 1 ? '' : 's'} changed in the last ${days} day${days === 1 ? '' : 's'}.`,
      'BambooHR does not say which field changed, only that the record did.',
    ];
    if (unnamed) {
      notes.push(
        `${unnamed} of these are no longer on the roster — usually records that were deleted.`,
      );
    }

    return {
      ...OK_STATUS,
      ...empty,
      changes: limited,
      totalChanged: changes.length,
      guidance: notes.join(' '),
    };
  },
});
