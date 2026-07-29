import { z } from 'zod';
import { registerTool } from '../index';
import { bambooFetch } from './client';
import { resolveEmployee } from './roster';
import {
  DATASET,
  OK_STATUS,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from './shape';

/**
 * Time off: who is away, what has been requested, and how much anyone has left.
 *
 * "Who is out this week" is one of the questions a team bot gets asked most, so
 * `whos_out` is deliberately the cheapest thing in this family — one call, no
 * roster join, no rates anywhere near it.
 *
 * All three are READ ONLY. BambooHR's time-off API can approve, deny and cancel
 * requests; none of that is exposed. An agent that can approve somebody's
 * holiday on their manager's behalf is not a feature anyone asked for.
 */

// A year of requests is a lot of rows and nobody asks a bot about last decade.
const MAX_RANGE_DAYS = 400;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Who's out
// ---------------------------------------------------------------------------

interface RawWhosOut {
  id?: number;
  type?: string;
  employeeId?: number;
  name?: string;
  start?: string;
  end?: string;
}

const absenceSchema = z.object({
  name: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  /** "timeOff" for a person's leave, "holiday" for a company holiday. */
  kind: z.string().nullable(),
  days: z.number().nullable(),
});

function daysBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export const bambooWhosOut = registerTool({
  id: 'bamboo.whos_out',
  description:
    'See who is away from Zipdev over a date range, straight from BambooHR — holidays, sick days and any other approved leave, plus company holidays. Defaults to the next two weeks. This is the tool for "who is out this week?" or "is anyone off on Friday?".',
  inputSchema: z.object({
    start: dateInput.optional().describe('First day to check, YYYY-MM-DD. Defaults to today.'),
    end: dateInput.optional().describe('Last day to check. Defaults to two weeks from the start.'),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    absences: z.array(absenceSchema),
    peopleOut: z.number(),
    start: z.string(),
    end: z.string(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const start = input.start ?? today();
    const end = input.end ?? plusDays(start, 14);
    const empty = {
      source: sourceOf(DATASET.timeOff),
      absences: [] as z.infer<typeof absenceSchema>[],
      peopleOut: 0,
      start,
      end,
      guidance: '',
    };

    if ((daysBetween(start, end) ?? 0) > MAX_RANGE_DAYS) {
      return {
        ...empty,
        configured: true,
        reason: `That range is too long to read in one go — ask me for up to ${MAX_RANGE_DAYS} days at a time.`,
      };
    }

    const res = await bambooFetch<RawWhosOut[]>(ctx, 'GET', '/time_off/whos_out', {
      params: { start, end },
    });
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rows = Array.isArray(res.data) ? res.data : [];
    const absences = rows
      .map((row) => ({
        name: str(row.name),
        start: str(row.start),
        end: str(row.end),
        kind: str(row.type),
        days: daysBetween(str(row.start), str(row.end)),
      }))
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

    const people = new Set(
      absences.filter((a) => a.kind === 'timeOff' && a.name).map((a) => a.name),
    );

    return {
      ...OK_STATUS,
      ...empty,
      absences,
      peopleOut: people.size,
      guidance: absences.length
        ? `${people.size} ${people.size === 1 ? 'person is' : 'people are'} away between ${start} and ${end}. Company holidays appear here too, marked as holidays rather than a person's leave.`
        : `Nobody is booked off between ${start} and ${end}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface RawRequest {
  id?: string;
  employeeId?: string;
  name?: string;
  start?: string;
  end?: string;
  created?: string;
  status?: { status?: string; lastChanged?: string };
  type?: { name?: string };
  amount?: { unit?: string; amount?: string };
  notes?: { employee?: string; manager?: string };
}

const requestSchema = z.object({
  name: z.string().nullable(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  amount: z.number().nullable(),
  unit: z.string().nullable(),
  requestedOn: z.string().nullable(),
  employeeNote: z.string().nullable(),
});

const MAX_NOTE = 300;

export const bambooTimeOffRequests = registerTool({
  id: 'bamboo.time_off_requests',
  description:
    'List time-off requests from BambooHR over a date range — approved, still waiting for approval, denied or cancelled — with who asked, what kind of leave, how long, and any note they left. Use it for "what\'s waiting for approval?", "how much holiday has the team booked next month?" or to check one person\'s requests. Read-only: I can show requests but never approve, deny or cancel one.',
  inputSchema: z.object({
    start: dateInput.optional().describe('First day of the range. Defaults to today.'),
    end: dateInput.optional().describe('Last day. Defaults to 30 days after the start.'),
    status: z
      .enum(['approved', 'denied', 'superseded', 'requested', 'canceled', 'any'])
      .default('any')
      .describe('"requested" means still waiting for a decision'),
    name: z.string().max(120).optional().describe('Limit to one person, by name'),
    email: z.string().max(160).optional().describe('Limit to one person, by work email'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    requests: z.array(requestSchema),
    totalMatched: z.number(),
    awaitingApproval: z.number(),
    start: z.string(),
    end: z.string(),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const start = input.start ?? today();
    const end = input.end ?? plusDays(start, 30);
    const empty = {
      source: sourceOf(DATASET.timeOff),
      requests: [] as z.infer<typeof requestSchema>[],
      totalMatched: 0,
      awaitingApproval: 0,
      start,
      end,
      candidates: [] as string[],
      guidance: '',
    };

    if ((daysBetween(start, end) ?? 0) > MAX_RANGE_DAYS) {
      return {
        ...empty,
        configured: true,
        reason: `That range is too long to read in one go — ask me for up to ${MAX_RANGE_DAYS} days at a time.`,
      };
    }

    let employeeId: string | undefined;
    if (input.name || input.email) {
      const resolved = await resolveEmployee(ctx, { name: input.name, email: input.email });
      if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
      const r = resolved.data;
      if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
      if (r.kind === 'ambiguous') {
        return { ...empty, configured: true, reason: r.reason, candidates: r.candidates };
      }
      employeeId = String(r.row.id);
    }

    const wantStatus = input.status ?? 'any';
    const res = await bambooFetch<RawRequest[]>(ctx, 'GET', '/time_off/requests', {
      params: {
        start,
        end,
        employeeId,
        status: wantStatus === 'any' ? undefined : wantStatus,
      },
    });
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rows = Array.isArray(res.data) ? res.data : [];
    const requests = rows
      .map((row) => {
        const amount = row.amount?.amount;
        const parsed = amount === undefined ? null : Number.parseFloat(String(amount));
        const note = str(row.notes?.employee);
        return {
          name: str(row.name),
          type: str(row.type?.name),
          status: str(row.status?.status),
          start: str(row.start),
          end: str(row.end),
          amount: parsed !== null && Number.isFinite(parsed) ? parsed : null,
          unit: str(row.amount?.unit),
          requestedOn: str(row.created),
          employeeNote: note ? note.slice(0, MAX_NOTE) : null,
        };
      })
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

    const pending = requests.filter((r) => r.status === 'requested').length;

    return {
      ...OK_STATUS,
      ...empty,
      requests: requests.slice(0, input.limit ?? 50),
      totalMatched: requests.length,
      awaitingApproval: pending,
      guidance: !requests.length
        ? `No time-off requests between ${start} and ${end}.`
        : pending
          ? `${requests.length} request${requests.length === 1 ? '' : 's'} in that window, ${pending} still waiting for a decision. Approving them has to happen in BambooHR — I only read.`
          : `${requests.length} request${requests.length === 1 ? '' : 's'} in that window, none awaiting approval.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

interface RawBalance {
  timeOffType?: string;
  name?: string;
  units?: string;
  balance?: string;
  end?: string;
  policyType?: string;
  usedYearToDate?: string;
}

const balanceSchema = z.object({
  policy: z.string().nullable(),
  balance: z.number().nullable(),
  usedThisYear: z.number().nullable(),
  unit: z.string().nullable(),
  /** accruing, discretionary or manual — how the policy grants time. */
  policyType: z.string().nullable(),
});

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

export const bambooTimeOffBalance = registerTool({
  id: 'bamboo.time_off_balance',
  description:
    'Show how much time off one person has left in BambooHR, by policy — holiday, sick days, unpaid days and anything else they are enrolled in — along with how much they have already used this year. Answers "how much holiday does she have left?". Balances are projected to the end of this year unless you ask for a different date.',
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
      asOf: dateInput
        .optional()
        .describe(
          'Project the balance to this date, YYYY-MM-DD. Defaults to the end of this year.',
        ),
    })
    .refine((v) => !!(v.name || v.email), { message: 'Give me a name or a work email' }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employeeName: z.string().nullable(),
    asOf: z.string(),
    balances: z.array(balanceSchema),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const asOf = input.asOf ?? `${new Date().getUTCFullYear()}-12-31`;
    const empty = {
      source: sourceOf(DATASET.timeOffBalance),
      found: false,
      employeeName: null,
      asOf,
      balances: [] as z.infer<typeof balanceSchema>[],
      candidates: [] as string[],
      guidance: '',
    };

    const resolved = await resolveEmployee(ctx, { name: input.name, email: input.email });
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return { ...empty, configured: true, reason: r.reason, candidates: r.candidates };
    }

    // BambooHR's `/time_off/balance` route does not exist on this instance; the
    // calculator endpoint is the one that answers "how much is left".
    const res = await bambooFetch<RawBalance[]>(
      ctx,
      'GET',
      `/employees/${String(r.row.id)}/time_off/calculator`,
      { params: { end: asOf } },
    );
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rows = Array.isArray(res.data) ? res.data : [];
    const balances = rows.map((row) => ({
      policy: str(row.name),
      balance: num(row.balance),
      usedThisYear: num(row.usedYearToDate),
      unit: str(row.units),
      policyType: str(row.policyType),
    }));

    const withTime = balances.filter((b) => (b.balance ?? 0) > 0);

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: str(r.row.displayName),
      balances,
      guidance: !balances.length
        ? 'This person is not enrolled in any time-off policy in BambooHR.'
        : `Balances are projected to ${asOf}. ${withTime.length ? `${withTime.length} of ${balances.length} policies still have time on them.` : 'Nothing is left on any policy.'} Most Zipdev policies are counted in hours, not days.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Policy catalogue
// ---------------------------------------------------------------------------

interface RawTypes {
  timeOffTypes?: Array<{ id?: string; name?: string; units?: string }>;
}

export const bambooTimeOffTypes = registerTool({
  id: 'bamboo.time_off_types',
  description:
    'List the kinds of time off Zipdev offers in BambooHR — holiday, sick, parental, unpaid and so on — and whether each is counted in hours or days. Useful when someone asks what leave exists, or before interpreting a balance. Contains no personal data at all.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    types: z.array(z.object({ name: z.string().nullable(), unit: z.string().nullable() })),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (_input, ctx) => {
    const empty = { source: sourceOf(DATASET.timeOffTypes), types: [], guidance: '' };

    const res = await bambooFetch<RawTypes>(ctx, 'GET', '/meta/time_off/types');
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const types = (res.data?.timeOffTypes ?? []).map((t) => ({
      name: str(t.name),
      unit: str(t.units),
    }));

    return {
      ...OK_STATUS,
      ...empty,
      types,
      guidance: types.length
        ? `Zipdev has ${types.length} kinds of time off set up in BambooHR.`
        : 'No time-off policies are set up in BambooHR.',
    };
  },
});
