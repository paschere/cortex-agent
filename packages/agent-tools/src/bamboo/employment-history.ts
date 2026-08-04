import { z } from "zod";
import { registerTool } from "../index";
import { bambooFetch } from "./client";
import { resolveEmployee } from "./roster";
import {
  DATASET,
  OK_STATUS,
  TABLE,
  dateStr,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * One person's career at Cortex: every client move, title change, manager
 * change and status change, in order.
 *
 * The roster only shows today. "How long has she been on that account?" and
 * "has he been moved between clients a lot?" are answered from the two
 * historical tables BambooHR keeps behind the current values — and at a
 * staffing company, moves between clients are the substance of the record.
 *
 * Carries no compensation: the rate timeline is a separate, separately
 * classified tool.
 */

interface RawJobRow {
  date?: string | null;
  location?: string | null;
  department?: string | null;
  division?: string | null;
  jobTitle?: string | null;
  reportsTo?: string | null;
}

interface RawStatusRow {
  date?: string | null;
  employmentStatus?: string | null;
  comment?: string | null;
  terminationReasonId?: string | null;
  terminationTypeId?: string | null;
  terminationRehireId?: string | null;
}

const jobChangeSchema = z.object({
  effectiveDate: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /** BambooHR's "department" — at Cortex, the client the person was placed with. */
  client: z.string().nullable(),
  division: z.string().nullable(),
  location: z.string().nullable(),
  reportsTo: z.string().nullable(),
  /** What actually changed against the previous row, in plain words. */
  whatChanged: z.array(z.string()),
});

const statusChangeSchema = z.object({
  effectiveDate: z.string().nullable(),
  employmentType: z.string().nullable(),
  note: z.string().nullable(),
  terminationReason: z.string().nullable(),
  terminationType: z.string().nullable(),
  eligibleForRehire: z.string().nullable(),
});

export const bambooEmploymentHistory = registerTool({
  id: "bamboo.employment_history",
  description:
    "Show one person's history at Cortex from BambooHR: every time they changed client or project, job title, division, location or manager, plus every change to their employment status (hired, terminated, re-hired, moved to bench, contractor). Answers questions like how long someone has been on their current account, how often they have been moved, or why and when they left. Contains no pay or bill rates.",
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
    })
    .refine((v) => !!(v.name || v.email), {
      message: "Give me a name or a work email",
    }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employeeName: z.string().nullable(),
    jobChanges: z.array(jobChangeSchema),
    statusChanges: z.array(statusChangeSchema),
    currentClientSince: z.string().nullable(),
    clientsWorkedWith: z.array(z.string()),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 12 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.employmentHistory),
      found: false,
      employeeName: null,
      jobChanges: [] as z.infer<typeof jobChangeSchema>[],
      statusChanges: [] as z.infer<typeof statusChangeSchema>[],
      currentClientSince: null,
      clientsWorkedWith: [] as string[],
      candidates: [] as string[],
      guidance: "",
    };

    const resolved = await resolveEmployee(ctx, {
      name: input.name,
      email: input.email,
    });
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === "none")
      return { ...empty, configured: true, reason: r.reason };
    if (r.kind === "ambiguous") {
      return {
        ...empty,
        configured: true,
        reason: r.reason,
        candidates: r.candidates,
      };
    }

    const id = String(r.row.id);

    const [jobRes, statusRes] = await Promise.all([
      bambooFetch<RawJobRow[]>(
        ctx,
        "GET",
        `/employees/${id}/tables/${TABLE.jobInfo}`,
      ),
      bambooFetch<RawStatusRow[]>(
        ctx,
        "GET",
        `/employees/${id}/tables/${TABLE.employmentStatus}`,
      ),
    ]);
    if (!jobRes.ok) return { ...empty, ...failureStatus(jobRes) };

    const jobRows = (Array.isArray(jobRes.data) ? jobRes.data : [])
      .map((row) => ({
        effectiveDate: dateStr(row.date),
        jobTitle: str(row.jobTitle),
        client: str(row.department),
        division: str(row.division),
        location: str(row.location),
        reportsTo: str(row.reportsTo),
      }))
      .sort((a, b) =>
        (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? ""),
      );

    const jobChanges = jobRows.map((row, i) => {
      const prev = i > 0 ? jobRows[i - 1] : undefined;
      const whatChanged: string[] = [];
      if (!prev) whatChanged.push("first record");
      else {
        if (prev.client !== row.client) whatChanged.push("client");
        if (prev.jobTitle !== row.jobTitle) whatChanged.push("job title");
        if (prev.division !== row.division) whatChanged.push("division");
        if (prev.location !== row.location) whatChanged.push("location");
        if (prev.reportsTo !== row.reportsTo) whatChanged.push("manager");
      }
      return { ...row, whatChanged };
    });

    const statusChanges = (
      statusRes.ok && Array.isArray(statusRes.data) ? statusRes.data : []
    )
      .map((row) => ({
        effectiveDate: dateStr(row.date),
        employmentType: str(row.employmentStatus),
        note: str(row.comment),
        terminationReason: str(row.terminationReasonId),
        terminationType: str(row.terminationTypeId),
        eligibleForRehire: str(row.terminationRehireId),
      }))
      .sort((a, b) =>
        (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? ""),
      );

    const currentClient = jobRows.length
      ? jobRows[jobRows.length - 1]?.client
      : null;
    // Walk back while the client is unchanged: a title change on the same
    // account must not reset "on this client since".
    let currentClientSince: string | null = null;
    for (let i = jobRows.length - 1; i >= 0; i--) {
      const row = jobRows[i];
      if (!row || row.client !== currentClient) break;
      currentClientSince = row.effectiveDate;
    }

    const clientsWorkedWith = [
      ...new Set(jobRows.map((j) => j.client).filter((c): c is string => !!c)),
    ];

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: str(r.row.displayName),
      jobChanges,
      statusChanges,
      currentClientSince,
      clientsWorkedWith,
      guidance: jobChanges.length
        ? `${jobChanges.length} job record${jobChanges.length === 1 ? "" : "s"} and ${statusChanges.length} status change${statusChanges.length === 1 ? "" : "s"} on file. Remember BambooHR's "department" here is the client they were placed with.`
        : "BambooHR has no job history rows for this person beyond their current record.",
    };
  },
});
