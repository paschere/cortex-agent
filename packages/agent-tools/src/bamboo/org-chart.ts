import { z } from 'zod';
import { registerTool } from '../index';
import { fetchReport, resolveEmployee } from './roster';
import {
  DATASET,
  FIELD,
  OK_STATUS,
  type ReportRow,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from './shape';

/**
 * Reporting lines around one person: who they report to, the chain above them,
 * and everyone who reports to them.
 *
 * BambooHR only stores the single upward link (`reportsTo`), so downward
 * reports and the chain above are both derived by scanning the roster. That
 * scan is done once per call over a lean projection rather than by walking the
 * per-employee endpoint N times.
 */

const MAX_CHAIN = 8;

const personSchema = z.object({
  name: z.string().nullable(),
  jobTitle: z.string().nullable(),
  client: z.string().nullable(),
  division: z.string().nullable(),
});

export const bambooOrgChart = registerTool({
  id: 'bamboo.org_chart',
  description:
    'Show the reporting lines around one person in BambooHR: their manager, the management chain above them, and every person who reports to them directly. Answers "who does she report to?", "who is on his team?" and "how many people report to X?". Also names the client-side contact for people placed with a client. No pay or bill rates.',
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
      includeInactive: z
        .boolean()
        .default(false)
        .describe('Include people who have left when listing direct reports'),
    })
    .refine((v) => !!(v.name || v.email), { message: 'Give me a name or a work email' }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    person: personSchema.nullable(),
    manager: personSchema.nullable(),
    /** From their manager upward, nearest first. */
    managementChain: z.array(personSchema),
    directReports: z.array(personSchema),
    directReportCount: z.number(),
    clientSideManager: z.string().nullable(),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.orgChart),
      found: false,
      person: null,
      manager: null,
      managementChain: [] as z.infer<typeof personSchema>[],
      directReports: [] as z.infer<typeof personSchema>[],
      directReportCount: 0,
      clientSideManager: null,
      candidates: [] as string[],
      guidance: '',
    };

    const fields = [FIELD.managerName];
    const resolved = await resolveEmployee(ctx, { name: input.name, email: input.email }, fields);
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return { ...empty, configured: true, reason: r.reason, candidates: r.candidates };
    }

    const rosterRes = await fetchReport(ctx, [
      'id',
      'displayName',
      'jobTitle',
      'department',
      'division',
      'status',
      'reportsTo',
    ]);
    if (!rosterRes.ok) return { ...empty, ...failureStatus(rosterRes) };

    const project = (row: ReportRow) => ({
      name: str(row.displayName),
      jobTitle: str(row.jobTitle),
      client: str(row.department),
      division: str(row.division),
    });

    const rows = rosterRes.data;
    const byName = new Map<string, ReportRow>();
    for (const row of rows) {
      const n = str(row.displayName);
      // An active record wins a name collision — the chain should walk through
      // the person who is actually here.
      if (n && (!byName.has(n) || str(row.status) === 'Active')) byName.set(n, row);
    }

    const self = r.row;
    const selfName = str(self.displayName);
    const managerName = str(self.reportsTo);
    const managerRow = managerName ? byName.get(managerName) : undefined;

    const chain: z.infer<typeof personSchema>[] = [];
    const seen = new Set<string>([selfName ?? '']);
    let cursor = managerRow;
    while (cursor && chain.length < MAX_CHAIN) {
      const n = str(cursor.displayName);
      if (!n || seen.has(n)) break; // a self-referential chain must not loop forever
      seen.add(n);
      chain.push(project(cursor));
      const next = str(cursor.reportsTo);
      cursor = next ? byName.get(next) : undefined;
    }

    const reports = rows.filter((row) => {
      if (str(row.reportsTo) !== selfName) return false;
      if (!input.includeInactive && str(row.status) !== 'Active') return false;
      return true;
    });

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      person: project(self),
      manager: managerRow
        ? project(managerRow)
        : managerName
          ? { name: managerName, jobTitle: null, client: null, division: null }
          : null,
      managementChain: chain,
      directReports: reports
        .map(project)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      directReportCount: reports.length,
      clientSideManager: str(self.customManagerName),
      guidance: reports.length
        ? `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to them directly.`
        : 'Nobody reports to them in BambooHR.',
    };
  },
});
