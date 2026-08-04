import { z } from "zod";
import { registerTool } from "../index";
import { resolveEmployee } from "./roster";
import {
  DATASET,
  FIELD,
  OK_STATUS,
  PAYROLL_BOUNDARY_NOTE,
  RATE_GLOSSARY,
  adaptEmployee,
  compensationSchema,
  computeMargin,
  dateStr,
  describeTenure,
  employeeSchema,
  failureStatus,
  monthsBetween,
  parseMoney,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * One person's full profile, compensation included.
 *
 * This is the tool that carries pay AND bill rate for a named individual, which
 * is why it is classified `financial` in the security policy rather than
 * inheriting the family's PII default.
 */

export const PROFILE_FIELDS = [
  "id",
  "displayName",
  "workEmail",
  "jobTitle",
  "department",
  "division",
  "location",
  "status",
  "employmentHistoryStatus",
  "hireDate",
  "originalHireDate",
  "terminationDate",
  "reportsTo",
  "supervisorEmail",
  "payRate",
  "payPeriod",
  "payType",
  "payFrequency",
  "timeTrackingEnabled",
  FIELD.billRate,
  FIELD.billRateEffectiveDate,
  FIELD.clientProject,
  FIELD.managerName,
  FIELD.managerEmail,
  FIELD.internalPod,
  FIELD.assignedCsm,
  FIELD.assignedTsp,
];

export const bambooGetEmployee = registerTool({
  id: "bamboo.get_employee",
  description: [
    "Look up one person's full record in BambooHR by name or work email: job title, the client they are placed with, division, location, employment type, hire date and tenure, who they report to internally, their contact on the client side, and their compensation — both the pay rate Cortex pays them and the bill rate Cortex charges the client. Because it carries compensation, use bamboo.list_employees instead when someone only wants to know who does what.",
    "This is the only place the bill rate and the margin for one person live. payroll.employee_profile covers the same person from the payroll service and adds what they were actually paid period by period, plus their expenses — but has no bill rate.",
    PAYROLL_BOUNDARY_NOTE,
  ].join(" "),
  inputSchema: z
    .object({
      name: z
        .string()
        .max(120)
        .optional()
        .describe('Full or partial name, e.g. "Emmanuel Castro"'),
      email: z.string().max(160).optional().describe("Their Cortex work email"),
      includeCompensation: z
        .boolean()
        .default(true)
        .describe("Set false to get the profile without any pay or bill rate"),
    })
    .refine((v) => !!(v.name || v.email), {
      message: "Give me a name or a work email",
    }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employee: employeeSchema.nullable(),
    placement: z
      .object({
        clientProject: z.string().nullable(),
        clientManagerName: z.string().nullable(),
        clientManagerEmail: z.string().nullable(),
        internalPod: z.string().nullable(),
        clientSuccessManager: z.string().nullable(),
        technicalSuccessPartner: z.string().nullable(),
        managerEmail: z.string().nullable(),
        tracksTime: z.boolean(),
      })
      .nullable(),
    compensation: compensationSchema.nullable(),
    /** Names to disambiguate between when the search matched more than one person. */
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.employee),
      found: false,
      employee: null,
      placement: null,
      compensation: null,
      candidates: [] as string[],
      guidance: "",
    };

    const res = await resolveEmployee(
      ctx,
      { name: input.name, email: input.email },
      PROFILE_FIELDS,
    );
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const r = res.data;
    if (r.kind === "none")
      return { ...empty, configured: true, reason: r.reason };
    if (r.kind === "ambiguous") {
      return {
        ...empty,
        configured: true,
        reason: r.reason,
        candidates: r.candidates,
        guidance:
          "Ask which of these people they meant, then look that one up by full name.",
      };
    }

    const row = r.row;
    const employee = adaptEmployee(row);

    // BambooHR keeps the original hire date separately for re-hires; tenure that
    // ignores it understates how long someone has actually been with Cortex.
    const originalHire = dateStr(row.originalHireDate);
    const rehired = !!(
      originalHire &&
      employee.hireDate &&
      originalHire !== employee.hireDate
    );

    const placement = {
      clientProject: str(row["customProject/Client"]) ?? employee.department,
      clientManagerName: str(row.customManagerName),
      clientManagerEmail: str(row.customManagerEmail),
      internalPod: str(row.customInternalPod),
      clientSuccessManager: str(row.customAssignedCSM),
      technicalSuccessPartner: str(row.customAssignedTSP),
      managerEmail: str(row.supervisorEmail),
      tracksTime: str(row.timeTrackingEnabled) === "1",
    };

    let compensation = null;
    if (input.includeCompensation !== false) {
      const payRate = parseMoney(row.payRate);
      const billRate = parseMoney(row.customBillRate);
      compensation = {
        payRate,
        payFrequency: str(row.payFrequency) ?? str(row.payPeriod),
        paidPer: str(row.payPeriod),
        payType: str(row.payType),
        billRate,
        billRateEffectiveDate: dateStr(row.customBillRateEffectiveDate),
        ...computeMargin(payRate, billRate),
      };
    }

    const notes: string[] = [];
    if (rehired) {
      const total = describeTenure(monthsBetween(originalHire));
      notes.push(
        `They were originally hired on ${originalHire} and re-hired on ${employee.hireDate}; counting from the first hire that is ${total} with Cortex in total.`,
      );
    }
    if (compensation) {
      notes.push(RATE_GLOSSARY);
      if (compensation.billRate.amount === null) {
        notes.push(
          "There is no bill rate recorded for this person in BambooHR.",
        );
      } else if (
        compensation.grossMargin.amount === null &&
        compensation.payRate.amount !== null
      ) {
        notes.push(
          "Pay and bill are recorded in different currencies, so I have not subtracted one from the other — that would be a made-up number.",
        );
      }
    }
    if (employee.status !== "Active") {
      notes.push("This person is no longer active in BambooHR.");
    }

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employee,
      placement,
      compensation,
      guidance: notes.join(" "),
    };
  },
});
