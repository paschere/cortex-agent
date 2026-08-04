import { z } from "zod";
import { registerTool } from "../index";
import { fetchReport } from "./roster";
import {
  DATASET,
  OK_STATUS,
  PAYROLL_BOUNDARY_NOTE,
  ROSTER_FIELDS,
  type ReportRow,
  adaptEmployee,
  employeeSchema,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * The roster, without a single figure of compensation on it.
 *
 * Keeping pay out of the everyday "who works here" question is the whole point:
 * it is the tool people will reach for twenty times a day, and it should not
 * spend anybody's confirmation or drag a compensation flag onto an ordinary
 * headcount answer. Anyone who actually wants rates asks for compensation
 * explicitly, and that is a different, gated tool.
 */

const MAX_RESULTS = 200;

function matches(value: string | null, wanted: string | undefined): boolean {
  if (!wanted) return true;
  if (!value) return false;
  return value.toLowerCase().includes(wanted.toLowerCase());
}

export const bambooListEmployees = registerTool({
  id: "bamboo.list_employees",
  description: [
    "List the people in BambooHR — Cortex's HR system of record — with their job title, client, division, location, employment type, hire date and who they report to. Filterable by any of those, and by name. This is the everyday \"who works here\" answer and the default for \"who is on <client>\". Carries NO pay or bill rates; ask for compensation separately if that is what you need. Note the BambooHR convention at Cortex: 'department' holds the CLIENT or project someone is placed with, and 'division' is the internal grouping (Tech, Non-tech, Internal, LatAm Staff).",
    "Related but different: payroll.team_assignments lists the same kind of people from the payroll service and adds what each costs per month; people.search finds a colleague's email in the Google directory and knows nothing about placements.",
    PAYROLL_BOUNDARY_NOTE,
  ].join(" "),
  inputSchema: z.object({
    status: z
      .enum(["active", "inactive", "any"])
      .default("active")
      .describe(
        "Whether to include people who have left. Defaults to current employees only.",
      ),
    search: z
      .string()
      .max(120)
      .optional()
      .describe("Match part of a name or work email"),
    department: z
      .string()
      .max(120)
      .optional()
      .describe(
        'The client or project someone is placed with, e.g. "Momentive Software"',
      ),
    division: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Internal grouping, e.g. "Tech", "Non-tech", "Internal", "LatAm Staff"',
      ),
    jobTitle: z.string().max(120).optional(),
    location: z
      .string()
      .max(120)
      .optional()
      .describe('Country or office, e.g. "Mexico"'),
    employmentType: z
      .string()
      .max(60)
      .optional()
      .describe(
        "Full-Time, Part-Time, Contractor, Bench, Payroll Only, Terminated",
      ),
    reportsTo: z
      .string()
      .max(120)
      .optional()
      .describe("Match part of the manager's name"),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(50),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    employees: z.array(employeeSchema),
    totalMatched: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.roster),
      employees: [],
      totalMatched: 0,
      guidance: "",
    };

    const res = await fetchReport(ctx, ROSTER_FIELDS);
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const wantStatus = input.status ?? "active";
    const filtered = res.data.filter((row: ReportRow) => {
      const status = str(row.status);
      if (wantStatus === "active" && status !== "Active") return false;
      if (wantStatus === "inactive" && status === "Active") return false;
      if (input.search) {
        const hay = `${str(row.displayName) ?? ""} ${str(row.workEmail) ?? ""}`;
        if (!matches(hay, input.search)) return false;
      }
      return (
        matches(str(row.department), input.department) &&
        matches(str(row.division), input.division) &&
        matches(str(row.jobTitle), input.jobTitle) &&
        matches(str(row.location), input.location) &&
        matches(str(row.employmentHistoryStatus), input.employmentType) &&
        matches(str(row.reportsTo), input.reportsTo)
      );
    });

    const limit = input.limit ?? 50;
    const employees = filtered.slice(0, limit).map(adaptEmployee);

    return {
      ...OK_STATUS,
      ...empty,
      employees,
      totalMatched: filtered.length,
      guidance: !filtered.length
        ? 'Nobody matched. The filters are matched loosely, so a shorter search term usually helps — and remember "department" here means the client someone is placed with.'
        : filtered.length > employees.length
          ? `Showing ${employees.length} of ${filtered.length} matches. Narrow the filters, or raise the limit, to see the rest.`
          : `${filtered.length} ${filtered.length === 1 ? "person" : "people"} matched. No pay or bill rates are included here.`,
    };
  },
});
