import { z } from 'zod';
import { registerTool } from '../index';
import { bambooFetch } from './client';
import { fetchReport, resolveEmployee } from './roster';
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
 * Time tracking — hours logged against clients.
 *
 * The raw endpoint is the largest thing in this family by a wide margin: a
 * fortnight of company-wide entries is over two thousand clock rows, each with
 * timestamps, timezones and project objects. None of that goes near the model.
 * `timesheet_summary` aggregates server-side into hours per person and per
 * client, and only `timesheet_entries` — scoped to one person and a bounded
 * window — ever returns individual rows.
 *
 * Read-only. BambooHR's time-tracking API can add, edit and approve entries;
 * approving somebody's timesheet is a payroll action and is not exposed.
 */

interface RawEntry {
  id?: number;
  employeeId?: number;
  type?: string;
  date?: string;
  hours?: number;
  note?: string | null;
  approved?: boolean;
  approvedAt?: string | null;
  projectInfo?: {
    project?: { id?: number; name?: string } | null;
    task?: { name?: string } | null;
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

// A quarter is as much as anyone asks about, and it keeps the upstream response
// to something that can be aggregated inside a request.
const MAX_RANGE_DAYS = 100;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function minusDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function rangeDays(start: string, end: string): number | null {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const personHoursSchema = z.object({
  name: z.string().nullable(),
  client: z.string().nullable(),
  hours: z.number(),
  daysLogged: z.number(),
  approvedHours: z.number(),
  unapprovedHours: z.number(),
});

const projectHoursSchema = z.object({
  project: z.string().nullable(),
  hours: z.number(),
  people: z.number(),
});

export const bambooTimesheetSummary = registerTool({
  id: 'bamboo.timesheet_summary',
  description:
    'Add up the hours logged in BambooHR time tracking over a date range — totals per person and per project, how many days each person logged, and how much is still unapproved. Defaults to the last two weeks. Use it for "how many hours did the team bill to X last month?", "who has not logged their time?" or "what is still waiting to be approved?". Only people with time tracking switched on appear here.',
  inputSchema: z.object({
    start: dateInput.optional().describe('First day, YYYY-MM-DD. Defaults to 14 days ago.'),
    end: dateInput.optional().describe('Last day. Defaults to today.'),
    name: z.string().max(120).optional().describe('Limit to one person, by name'),
    email: z.string().max(160).optional().describe('Limit to one person, by work email'),
    client: z.string().max(120).optional().describe('Limit to people placed with one client'),
    limit: z.number().int().min(1).max(150).default(60),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    start: z.string(),
    end: z.string(),
    totalHours: z.number(),
    peopleLogging: z.number(),
    byPerson: z.array(personHoursSchema),
    byProject: z.array(projectHoursSchema),
    unapprovedHours: z.number(),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 12 },
  handler: async (input, ctx) => {
    const end = input.end ?? today();
    const start = input.start ?? minusDays(end, 14);
    const empty = {
      source: sourceOf(DATASET.timesheets),
      start,
      end,
      totalHours: 0,
      peopleLogging: 0,
      byPerson: [] as z.infer<typeof personHoursSchema>[],
      byProject: [] as z.infer<typeof projectHoursSchema>[],
      unapprovedHours: 0,
      candidates: [] as string[],
      guidance: '',
    };

    const span = rangeDays(start, end);
    if (span === null || span < 1) {
      return {
        ...empty,
        configured: true,
        reason: 'That date range does not make sense — the end has to be on or after the start.',
      };
    }
    if (span > MAX_RANGE_DAYS) {
      return {
        ...empty,
        configured: true,
        reason: `That range is too long to add up in one go — ask me for up to ${MAX_RANGE_DAYS} days at a time.`,
      };
    }

    let employeeIds: string | undefined;
    if (input.name || input.email) {
      const resolved = await resolveEmployee(ctx, {
        name: input.name,
        email: input.email,
      });
      if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
      const r = resolved.data;
      if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
      if (r.kind === 'ambiguous') {
        return {
          ...empty,
          configured: true,
          reason: r.reason,
          candidates: r.candidates,
        };
      }
      employeeIds = String(r.row.id);
    }

    const [entryRes, rosterRes] = await Promise.all([
      bambooFetch<RawEntry[]>(ctx, 'GET', '/time_tracking/timesheet_entries', {
        params: { start, end, employeeIds },
      }),
      fetchReport(ctx, ['id', 'displayName', 'department', 'status']),
    ]);
    if (!entryRes.ok) return { ...empty, ...failureStatus(entryRes) };

    const byId = new Map<string, ReportRow>();
    if (rosterRes.ok) for (const row of rosterRes.data) byId.set(String(row.id), row);

    const entries = Array.isArray(entryRes.data) ? entryRes.data : [];

    interface Acc {
      name: string | null;
      client: string | null;
      hours: number;
      approved: number;
      unapproved: number;
      days: Set<string>;
    }
    const people = new Map<string, Acc>();
    const projects = new Map<string, { hours: number; people: Set<string> }>();
    let unapprovedTotal = 0;

    for (const e of entries) {
      const id = String(e.employeeId ?? '');
      const row = byId.get(id);
      const client = row ? str(row.department) : null;
      if (input.client && !client?.toLowerCase().includes(input.client.toLowerCase())) continue;

      const hours = typeof e.hours === 'number' && Number.isFinite(e.hours) ? e.hours : 0;
      const acc =
        people.get(id) ??
        ({
          name: row ? str(row.displayName) : null,
          client,
          hours: 0,
          approved: 0,
          unapproved: 0,
          days: new Set<string>(),
        } satisfies Acc);
      acc.hours += hours;
      if (e.approved) acc.approved += hours;
      else {
        acc.unapproved += hours;
        unapprovedTotal += hours;
      }
      const day = str(e.date);
      if (day) acc.days.add(day);
      people.set(id, acc);

      const project = str(e.projectInfo?.project?.name) ?? 'No project';
      const p = projects.get(project) ?? {
        hours: 0,
        people: new Set<string>(),
      };
      p.hours += hours;
      p.people.add(id);
      projects.set(project, p);
    }

    const byPerson = [...people.values()]
      .map((a) => ({
        name: a.name,
        client: a.client,
        hours: round(a.hours),
        daysLogged: a.days.size,
        approvedHours: round(a.approved),
        unapprovedHours: round(a.unapproved),
      }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, input.limit ?? 60);

    const byProject = [...projects.entries()]
      .map(([project, p]) => ({
        project,
        hours: round(p.hours),
        people: p.people.size,
      }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, input.limit ?? 60);

    const totalHours = round([...people.values()].reduce((s, a) => s + a.hours, 0));

    return {
      ...OK_STATUS,
      ...empty,
      totalHours,
      peopleLogging: people.size,
      byPerson,
      byProject,
      unapprovedHours: round(unapprovedTotal),
      guidance: !entries.length
        ? `No hours were logged between ${start} and ${end}. Only people with time tracking switched on log hours in BambooHR — most salaried staff do not.`
        : `${totalHours} hours from ${people.size} ${people.size === 1 ? 'person' : 'people'} between ${start} and ${end}${unapprovedTotal ? `, of which ${round(unapprovedTotal)} are not approved yet` : ''}. Approving timesheets has to happen in BambooHR — I only read them.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Individual entries
// ---------------------------------------------------------------------------

const entrySchema = z.object({
  date: z.string().nullable(),
  hours: z.number().nullable(),
  project: z.string().nullable(),
  task: z.string().nullable(),
  note: z.string().nullable(),
  approved: z.boolean(),
  /** "clock" for a punched entry, "manual" for one typed in. */
  kind: z.string().nullable(),
});

const MAX_NOTE = 200;
const MAX_ENTRY_RANGE_DAYS = 45;

export const bambooTimesheetEntries = registerTool({
  id: 'bamboo.timesheet_entries',
  description:
    "Show one person's individual time-tracking entries in BambooHR for a date range — each day, how many hours, against which project and task, any note they left, and whether it has been approved. Use it when a summary is not enough and someone needs to see the actual days. One person at a time, up to about six weeks.",
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
      start: dateInput.optional().describe('First day, YYYY-MM-DD. Defaults to 14 days ago.'),
      end: dateInput.optional().describe('Last day. Defaults to today.'),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .refine((v) => !!(v.name || v.email), {
      message: 'Give me a name or a work email',
    }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employeeName: z.string().nullable(),
    start: z.string(),
    end: z.string(),
    entries: z.array(entrySchema),
    totalHours: z.number(),
    daysLogged: z.number(),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const end = input.end ?? today();
    const start = input.start ?? minusDays(end, 14);
    const empty = {
      source: sourceOf(DATASET.timesheets),
      found: false,
      employeeName: null,
      start,
      end,
      entries: [] as z.infer<typeof entrySchema>[],
      totalHours: 0,
      daysLogged: 0,
      candidates: [] as string[],
      guidance: '',
    };

    const span = rangeDays(start, end);
    if (span === null || span < 1 || span > MAX_ENTRY_RANGE_DAYS) {
      return {
        ...empty,
        configured: true,
        reason: `Ask me for a window of up to ${MAX_ENTRY_RANGE_DAYS} days — for anything longer the hours summary is the better tool.`,
      };
    }

    const resolved = await resolveEmployee(ctx, {
      name: input.name,
      email: input.email,
    });
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return {
        ...empty,
        configured: true,
        reason: r.reason,
        candidates: r.candidates,
      };
    }

    const res = await bambooFetch<RawEntry[]>(ctx, 'GET', '/time_tracking/timesheet_entries', {
      params: { start, end, employeeIds: String(r.row.id) },
    });
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rows = Array.isArray(res.data) ? res.data : [];
    const entries = rows
      .map((e) => {
        const note = str(e.note);
        return {
          date: str(e.date),
          hours: typeof e.hours === 'number' && Number.isFinite(e.hours) ? round(e.hours) : null,
          project: str(e.projectInfo?.project?.name),
          task: str(e.projectInfo?.task?.name),
          note: note ? note.slice(0, MAX_NOTE) : null,
          approved: e.approved === true,
          kind: str(e.type),
        };
      })
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    const totalHours = round(entries.reduce((s, e) => s + (e.hours ?? 0), 0));
    const days = new Set(entries.map((e) => e.date).filter(Boolean));

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: str(r.row.displayName),
      entries: entries.slice(0, input.limit ?? 100),
      totalHours,
      daysLogged: days.size,
      guidance: entries.length
        ? `${totalHours} hours across ${days.size} day${days.size === 1 ? '' : 's'} between ${start} and ${end}.`
        : `They logged no hours between ${start} and ${end}. If they never do, time tracking is probably switched off for them — most salaried staff do not clock time.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface RawProject {
  id?: number;
  name?: string;
  hasTasks?: boolean;
  tasks?: Array<{ name?: string }>;
}

export const bambooEmployeeProjects = registerTool({
  id: 'bamboo.employee_projects',
  description:
    'List the time-tracking projects one person is allowed to log hours against in BambooHR. Useful for checking someone is set up on the right client before chasing missing hours. Contains no pay or personal data beyond the project names.',
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
    })
    .refine((v) => !!(v.name || v.email), {
      message: 'Give me a name or a work email',
    }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employeeName: z.string().nullable(),
    projects: z.array(z.object({ name: z.string().nullable(), hasTasks: z.boolean() })),
    guidance: z.string(),
    candidates: z.array(z.string()),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.projects),
      found: false,
      employeeName: null,
      projects: [] as Array<{ name: string | null; hasTasks: boolean }>,
      guidance: '',
      candidates: [] as string[],
    };

    const resolved = await resolveEmployee(ctx, {
      name: input.name,
      email: input.email,
    });
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return {
        ...empty,
        configured: true,
        reason: r.reason,
        candidates: r.candidates,
      };
    }

    const res = await bambooFetch<RawProject[]>(
      ctx,
      'GET',
      `/time_tracking/employee/${String(r.row.id)}/projects`,
    );
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rows = Array.isArray(res.data) ? res.data : [];
    const projects = rows.map((p) => ({
      name: str(p.name),
      hasTasks: p.hasTasks === true,
    }));

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: str(r.row.displayName),
      projects,
      guidance: projects.length
        ? `They can log time against ${projects.length} project${projects.length === 1 ? '' : 's'}.`
        : 'They are not set up on any time-tracking project, which usually means they do not clock time at all.',
    };
  },
});
