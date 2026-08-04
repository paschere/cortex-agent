import { z } from "zod";
import type { BambooFailure } from "./client";

/**
 * Shared shaping for the BambooHR tools — the same two jobs the Apollo family's
 * shape module does.
 *
 * 1. PROVENANCE. Every tool returns `source`, naming which part of BambooHR the
 *    facts came from and when. Compensation quoted by Cortex has to be traceable
 *    to a system and a timestamp, never sound like Cortex's own opinion.
 *
 * 2. SIZE. A raw BambooHR employee carries ~294 fields (visa numbers, bank
 *    accounts, dependants, COVID test history); a fortnight of timesheet
 *    entries for the company is over two thousand rows. Nothing raw is passed
 *    to the model: every tool projects into the lean shapes below, and the
 *    endpoints that return history are bounded before they are asked.
 */

/** Stamped on every result so Cortex can cite where a fact came from. */
export const sourceSchema = z.object({
  provider: z.literal("BambooHR"),
  dataset: z.string(),
  retrievedAt: z.string(),
});

/** Human names for the BambooHR datasets — never an endpoint path or a field id. */
export const DATASET = {
  roster: "BambooHR employee roster",
  employee: "BambooHR employee record",
  compensation: "BambooHR compensation record",
  compensationHistory: "BambooHR compensation history",
  employmentHistory: "BambooHR job and employment history",
  orgChart: "BambooHR reporting lines",
  headcount: "BambooHR headcount summary",
  changed: "BambooHR recently changed employees",
  timeOff: "BambooHR time off",
  timeOffBalance: "BambooHR time off balances",
  timeOffTypes: "BambooHR time off policies",
  timesheets: "BambooHR time tracking",
  projects: "BambooHR time tracking projects",
  documents: "BambooHR employee documents",
  fields: "BambooHR field catalogue",
} as const;

export function sourceOf(dataset: string): z.infer<typeof sourceSchema> {
  return {
    provider: "BambooHR",
    dataset,
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * Present on every BambooHR tool's output. `reason` is null on success and a
 * complete human sentence on any soft failure, so the model always has
 * something to say instead of an empty result it cannot explain.
 */
export const statusShape = {
  configured: z.boolean(),
  reason: z.string().nullable(),
};

export const OK_STATUS = { configured: true, reason: null };

export function failureStatus(f: BambooFailure): {
  configured: boolean;
  reason: string;
} {
  return { configured: f.configured, reason: f.reason };
}

// ---------------------------------------------------------------------------
// Cortex's BambooHR instance: the field ids that have no alias
// ---------------------------------------------------------------------------

/**
 * BambooHR gives its built-in fields a stable alias (`payRate`, `hireDate`)
 * but custom fields only have a numeric id, so custom fields must be requested
 * by number. These numbers were read from this instance's own `/meta/fields`
 * and `/meta/tables`; they are Cortex-specific and would differ in another
 * BambooHR account.
 *
 * BILL RATE IS REAL. It is custom field 4631 ("Bill Rate", currency), sitting
 * in the custom historical table `customBillRate1` alongside its effective date
 * (4630) and a comment (4632). Every currently-active employee has one. This
 * matters because the payroll app only ever syncs `payRate` — what Cortex PAYS
 * the person — and that is a cost, not a bill rate. The two are different
 * numbers about the same person and must never be relabelled into each other.
 */
export const FIELD = {
  billRate: "4631",
  billRateEffectiveDate: "4630",
  billRateComment: "4632",
  managerName: "4625",
  managerEmail: "4627",
  clientProject: "4626",
  internalPod: "4707",
  assignedCsm: "4708",
  assignedTsp: "4709",
} as const;

/** Custom historical tables in this instance, addressed by alias. */
export const TABLE = {
  billRate: "customBillRate1",
  managerInfo: "customManagerInformation",
  compensation: "compensation",
  jobInfo: "jobInfo",
  employmentStatus: "employmentStatus",
} as const;

/**
 * Employee-document categories, carried over from the payroll client. 24 is the
 * "Payment Receipts" root; payslips for a given year live in a per-year child
 * category. Used only to LABEL what a document is — this family never uploads,
 * never downloads and never deletes.
 */
export const PAYSTUB_CATEGORY_ID = 24;
export const PAYSTUB_YEAR_CATEGORIES: Record<number, number> = {
  2025: 29,
  2026: 32,
};

export function isPaystubCategory(categoryId: number): boolean {
  return (
    categoryId === PAYSTUB_CATEGORY_ID ||
    Object.values(PAYSTUB_YEAR_CATEGORIES).includes(categoryId)
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export const moneySchema = z.object({
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  /** Ready-to-read rendering, e.g. "5,500.00 USD". Null when there is no figure. */
  display: z.string().nullable(),
});

export type Money = z.infer<typeof moneySchema>;

export const NO_MONEY: Money = { amount: null, currency: null, display: null };

/**
 * BambooHR hands the same figure over in two different shapes depending on the
 * endpoint, and both arrive here:
 *
 *   - reports and the changed-tables feed:  "4500.00 USD"  (and " USD" for an
 *     employee who has no figure on file at all)
 *   - the per-employee tabular endpoints:   { value: "4500.00", currency: "USD" }
 *
 * The payroll sync handles the first by splitting on whitespace and taking
 * `[0]`, which yields the string "" for an empty rate and quietly writes a
 * blank pay rate. Parsing to a real number here means an absent rate is `null`
 * — visibly missing rather than silently zero.
 */
export function parseMoney(raw: unknown): Money {
  if (raw === null || raw === undefined) return NO_MONEY;

  if (typeof raw === "object") {
    const o = raw as { value?: unknown; currency?: unknown };
    const amount = toNumber(o.value);
    const currency =
      typeof o.currency === "string" && o.currency ? o.currency : null;
    return { amount, currency, display: renderMoney(amount, currency) };
  }

  if (typeof raw === "number") {
    return {
      amount: Number.isFinite(raw) ? raw : null,
      currency: null,
      display: null,
    };
  }

  if (typeof raw !== "string") return NO_MONEY;

  const trimmed = raw.trim();
  if (!trimmed) return NO_MONEY;

  // "4500.00 USD" — amount first, currency code second. Thousands separators
  // are stripped because BambooHR emits them for some locales.
  const parts = trimmed.split(/\s+/);
  const amount = toNumber(parts[0]);
  const currency = parts.length > 1 ? (parts[parts.length - 1] ?? null) : null;
  return { amount, currency, display: renderMoney(amount, currency) };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function renderMoney(
  amount: number | null,
  currency: string | null,
): string | null {
  if (amount === null) return null;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${formatted} ${currency}` : formatted;
}

// ---------------------------------------------------------------------------
// Dates and tenure
// ---------------------------------------------------------------------------

export function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

/** BambooHR writes "0000-00-00" for an unset date. */
export function dateStr(value: unknown): string | null {
  const s = str(value);
  if (!s || s.startsWith("0000")) return null;
  return s;
}

/** Whole months between two ISO dates, or null if the start is unusable. */
export function monthsBetween(
  from: string | null,
  to: Date = new Date(),
): number | null {
  if (!from) return null;
  const start = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const months =
    (to.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - start.getUTCMonth());
  const adjusted = to.getUTCDate() < start.getUTCDate() ? months - 1 : months;
  return adjusted < 0 ? null : adjusted;
}

/** "3 years, 2 months" — how a person would say it out loud. */
export function describeTenure(months: number | null): string | null {
  if (months === null) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (rest || !years) parts.push(`${rest} month${rest === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Employee projections
// ---------------------------------------------------------------------------

/**
 * In Cortex's instance the BambooHR "department" field holds the CLIENT the
 * person is placed with, not an internal department — the roster is full of
 * client names. "Division" is the internal grouping (Tech, Non-tech, Internal,
 * Cortex, LatAm Staff). Projecting `department` under a `client` label would be
 * guessing, so both are exposed under names that say what they literally are,
 * and the tool descriptions explain the convention.
 */
export const employeeSchema = z.object({
  /** Internal BambooHR reference. Present so tools can chain; never the way to refer to someone. */
  employeeId: z.string(),
  name: z.string().nullable(),
  workEmail: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /** BambooHR's "Department" — at Cortex this is the client or project name. */
  department: z.string().nullable(),
  /** BambooHR's "Division" — the internal grouping. */
  division: z.string().nullable(),
  location: z.string().nullable(),
  /** Active or Inactive. */
  status: z.string().nullable(),
  /** Full-Time, Part-Time, Contractor, Bench, Terminated, ... */
  employmentType: z.string().nullable(),
  hireDate: z.string().nullable(),
  terminationDate: z.string().nullable(),
  tenure: z.string().nullable(),
  reportsTo: z.string().nullable(),
});

export type Employee = z.infer<typeof employeeSchema>;

export type ReportRow = Record<string, unknown>;

export function adaptEmployee(row: ReportRow): Employee {
  const hireDate = dateStr(row.hireDate);
  return {
    employeeId: String(row.id ?? ""),
    name: str(row.displayName),
    workEmail: str(row.workEmail),
    jobTitle: str(row.jobTitle),
    department: str(row.department),
    division: str(row.division),
    location: str(row.location),
    status: str(row.status),
    employmentType: str(row.employmentHistoryStatus),
    hireDate,
    terminationDate: dateStr(row.terminationDate),
    tenure: describeTenure(monthsBetween(hireDate)),
    reportsTo: str(row.reportsTo),
  };
}

/** Fields every roster-shaped read asks for. Kept in one place so they cannot drift. */
export const ROSTER_FIELDS = [
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
  "terminationDate",
  "reportsTo",
];

// ---------------------------------------------------------------------------
// Compensation projection
// ---------------------------------------------------------------------------

/**
 * The truthful compensation shape.
 *
 * `payRate` is what Cortex PAYS the person — a cost.
 * `billRate` is what Cortex CHARGES the client for them — revenue.
 *
 * They are separate fields in BambooHR and they are separate numbers. Every
 * name and description in this family keeps them apart, and `margin` is only
 * ever computed when both are present AND in the same currency, because a
 * subtraction across two currencies is a wrong number that looks right.
 */
export const compensationSchema = z.object({
  payRate: moneySchema,
  payFrequency: z.string().nullable(),
  paidPer: z.string().nullable(),
  payType: z.string().nullable(),
  billRate: moneySchema,
  billRateEffectiveDate: z.string().nullable(),
  /** billRate − payRate, only when both exist in the same currency. */
  grossMargin: moneySchema,
  marginPercent: z.number().nullable(),
});

export type Compensation = z.infer<typeof compensationSchema>;

export function computeMargin(
  pay: Money,
  bill: Money,
): { grossMargin: Money; marginPercent: number | null } {
  if (pay.amount === null || bill.amount === null) {
    return { grossMargin: NO_MONEY, marginPercent: null };
  }
  // Comparing a monthly cost against an hourly bill rate, or USD against MXN,
  // produces a confident wrong answer — so neither is attempted.
  if (pay.currency && bill.currency && pay.currency !== bill.currency) {
    return { grossMargin: NO_MONEY, marginPercent: null };
  }
  const diff = bill.amount - pay.amount;
  const currency = bill.currency ?? pay.currency;
  const percent =
    bill.amount === 0 ? null : Math.round((diff / bill.amount) * 1000) / 10;
  return {
    grossMargin: {
      amount: Math.round(diff * 100) / 100,
      currency,
      display: renderMoney(Math.round(diff * 100) / 100, currency),
    },
    marginPercent: percent,
  };
}

/**
 * The sentence Cortex should lead with whenever it hands over a bill rate. Both
 * numbers describe the same person and are trivially confusable; saying which
 * is which every time is cheaper than one client conversation quoting a cost as
 * a price.
 */
export const RATE_GLOSSARY =
  "Pay rate is what Cortex pays the person (a cost). Bill rate is what Cortex charges the client for them (revenue). They are different fields in BambooHR — never quote one as the other.";

/**
 * BambooHR and the payroll service are two systems, not one system read twice.
 *
 * They cover overlapping ground — who works here, who they are placed with,
 * what they are paid — and they are maintained by different people, so they can
 * genuinely disagree about the same person. That disagreement is worth knowing
 * about, so no tool here is allowed to quietly resolve it: the model is told to
 * report both figures and name the source rather than average them or pick one.
 */
export const PAYROLL_BOUNDARY_NOTE =
  "SOURCE: BambooHR. The payroll service (payroll.*) is a separate system covering the same people, and holds what was actually paid out plus expenses. The two can hold different figures for the same person. If you have numbers from both and they disagree, give both and say which came from where — never average them or silently pick one.";
