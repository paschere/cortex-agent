import { z } from "zod";
import { registerTool } from "../index";
import { fetchReport } from "./roster";
import {
  DATASET,
  OK_STATUS,
  PAYROLL_BOUNDARY_NOTE,
  type ReportRow,
  failureStatus,
  monthsBetween,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * Headcount rollups — the SAFE way to look at the whole company.
 *
 * Deliberately aggregate-only: counts by client, division, location,
 * employment type and tenure band, and never a person or a rate. That is why
 * it is classified `internal` rather than inheriting the family's PII default,
 * and why "how many people do we have on X?" costs nobody a confirmation.
 * The same instinct as payroll's rollup tools: give people the aggregate so
 * they stop reaching for the per-person export.
 */

const bucketSchema = z.object({ label: z.string(), count: z.number() });

const GROUPINGS = [
  "client",
  "division",
  "location",
  "employmentType",
  "jobTitle",
] as const;

const TENURE_BANDS: Array<[string, (m: number) => boolean]> = [
  ["Under 6 months", (m) => m < 6],
  ["6–12 months", (m) => m >= 6 && m < 12],
  ["1–2 years", (m) => m >= 12 && m < 24],
  ["2–5 years", (m) => m >= 24 && m < 60],
  ["5+ years", (m) => m >= 60],
];

export const bambooHeadcount = registerTool({
  id: "bamboo.headcount",
  description: [
    'Count people in BambooHR, grouped however you need: by client or project, by division, by location, by employment type (full-time, contractor, bench) or by job title, plus a breakdown of how long people have been with Cortex. Returns counts only — no names, no pay, no bill rates — so it is the right tool for "how big is the team on X?", "how many people are on the bench?" or "how many are in Mexico?".',
    "payroll.team_overview answers the same shape of question from the payroll service, but only company-wide and without filters; this one is the one that can be narrowed.",
    PAYROLL_BOUNDARY_NOTE,
  ].join(" "),
  inputSchema: z.object({
    groupBy: z
      .enum(GROUPINGS)
      .default("division")
      .describe(
        '"client" is the BambooHR department field — the account someone is placed with',
      ),
    status: z.enum(["active", "inactive", "any"]).default("active"),
    client: z
      .string()
      .max(120)
      .optional()
      .describe("Narrow to one client before grouping"),
    division: z
      .string()
      .max(120)
      .optional()
      .describe("Narrow to one division before grouping"),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    total: z.number(),
    groupedBy: z.string(),
    groups: z.array(bucketSchema),
    byEmploymentType: z.array(bucketSchema),
    byTenure: z.array(bucketSchema),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.headcount),
      total: 0,
      groupedBy: input.groupBy ?? "division",
      groups: [] as Array<{ label: string; count: number }>,
      byEmploymentType: [] as Array<{ label: string; count: number }>,
      byTenure: [] as Array<{ label: string; count: number }>,
      guidance: "",
    };

    const res = await fetchReport(ctx, [
      "id",
      "status",
      "department",
      "division",
      "location",
      "jobTitle",
      "employmentHistoryStatus",
      "hireDate",
    ]);
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const wantStatus = input.status ?? "active";
    const rows = res.data.filter((row: ReportRow) => {
      const status = str(row.status);
      if (wantStatus === "active" && status !== "Active") return false;
      if (wantStatus === "inactive" && status === "Active") return false;
      if (
        input.client &&
        !str(row.department)?.toLowerCase().includes(input.client.toLowerCase())
      ) {
        return false;
      }
      if (
        input.division &&
        !str(row.division)?.toLowerCase().includes(input.division.toLowerCase())
      ) {
        return false;
      }
      return true;
    });

    const keyOf = (row: ReportRow): string => {
      switch (input.groupBy ?? "division") {
        case "client":
          return str(row.department) ?? "Not recorded";
        case "location":
          return str(row.location) ?? "Not recorded";
        case "employmentType":
          return str(row.employmentHistoryStatus) ?? "Not recorded";
        case "jobTitle":
          return str(row.jobTitle) ?? "Not recorded";
        default:
          return str(row.division) ?? "Not recorded";
      }
    };

    const tally = (fn: (row: ReportRow) => string) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const k = fn(row);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    };

    const groups = tally(keyOf).slice(0, input.limit ?? 30);

    const tenureCounts = new Map<string, number>();
    for (const row of rows) {
      const months = monthsBetween(str(row.hireDate));
      const band =
        months === null
          ? "Not recorded"
          : (TENURE_BANDS.find(([, f]) => f(months))?.[0] ?? "Not recorded");
      tenureCounts.set(band, (tenureCounts.get(band) ?? 0) + 1);
    }
    const order = [...TENURE_BANDS.map(([l]) => l), "Not recorded"];
    const byTenure = order
      .filter((l) => tenureCounts.has(l))
      .map((label) => ({ label, count: tenureCounts.get(label) as number }));

    return {
      ...OK_STATUS,
      ...empty,
      total: rows.length,
      groups,
      byEmploymentType: tally(
        (row) => str(row.employmentHistoryStatus) ?? "Not recorded",
      ),
      byTenure,
      guidance: rows.length
        ? `${rows.length} ${rows.length === 1 ? "person" : "people"} counted. These are counts only — no names or rates are included.`
        : "Nobody matched those filters.",
    };
  },
});
