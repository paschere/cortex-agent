import { IntegrationError } from "@cortex/core";
import type { ToolContext } from "../types";

export interface ClientCount {
  client: string;
  count: number;
}

export interface DivisionCount {
  division: string;
  count: number;
}

export interface CurrencyCount {
  currency: string;
  count: number;
}

export interface TeamOverview {
  asOf: string;
  totals: {
    totalUsers: number;
    active: number;
    assignedToClients: number;
    internal: number;
    newHires: number;
  };
  byDivision: DivisionCount[];
  byClient: ClientCount[];
  byCurrency: CurrencyCount[];
}

/**
 * Low-level GET against the payroll service's internal API.
 *
 * Config: only PAYROLL_API_URL is required. PAYROLL_API_TOKEN is OPTIONAL and
 * mirrors the payroll app's "optional token" policy (see the payroll repo's
 * src/app/api/internal/_auth.ts): the header is sent only when the token is
 * configured on this side, and the payroll app only enforces it when its own
 * INTERNAL_API_TOKEN is set. Both sides must be tightened before the payroll
 * app is exposed publicly.
 *
 * This is a separate service from the rate estimator — do not reuse
 * RATE_ESTIMATOR_*.
 */
export async function payrollFetch<T>(
  path: string,
  ctx: ToolContext,
): Promise<T> {
  const base = process.env.PAYROLL_API_URL;
  if (!base) {
    throw new IntegrationError(
      "Payroll integration not configured (PAYROLL_API_URL missing)",
      "payroll",
    );
  }
  const token = process.env.PAYROLL_API_TOKEN;

  const url = `${base.replace(/\/$/, "")}${path}`;
  const r = await fetch(url, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: ctx.signal,
  });
  if (!r.ok) {
    throw new IntegrationError(
      `Payroll ${r.status}: ${await r.text()}`,
      "payroll",
    );
  }
  return r.json() as Promise<T>;
}

/** Build a query string from defined params only. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Fetch the payroll team overview (headcount + distribution). */
export async function fetchTeamOverview(
  ctx: ToolContext,
): Promise<TeamOverview> {
  return payrollFetch<TeamOverview>("/api/internal/team-overview", ctx);
}

// ---------------------------------------------------------------------------
// Analytics payload shapes (mirror the payroll app's /api/internal/* routes)
// ---------------------------------------------------------------------------

export interface TeamAssignmentMember {
  id: number;
  name: string;
  email: string;
  client: string | null;
  division: string | null;
  jobTitle: string | null;
  currency: string | null;
  hireDate: string | null;
  tenureMonths: number | null;
  payRate: number | null;
  payRateUsd: number | null;
  payFrequency: number | null;
  newHire: boolean;
}

export interface TeamAssignments {
  asOf: string;
  filters: { client: string | null; division: string | null; q: string | null; limit: number };
  totals: {
    members: number;
    clients: number;
    divisions: number;
    newHires: number;
    withKnownRate: number;
    monthlyCostUsd: number;
    avgMonthlyCostUsd: number;
  };
  byClient: { client: string; count: number; monthlyCostUsd: number }[];
  byDivision: { division: string; count: number; monthlyCostUsd: number }[];
  byCurrency: { currency: string; count: number; monthlyCostUsd: number }[];
  members: TeamAssignmentMember[];
}

export interface EmployeeProfile {
  asOf: string;
  profile: {
    id: number;
    name: string;
    email: string;
    jobTitle: string | null;
    client: string | null;
    division: string | null;
    currency: string | null;
    hireDate: string | null;
    tenureMonths: number | null;
    active: boolean;
    newHire: boolean;
    excludeFromPayroll: boolean;
    payFrequency: number | null;
    timeTrackingEnabled: boolean;
  };
  compensation: {
    currentPayRate: number | null;
    currency: string | null;
    currentPayRateUsd: number | null;
    fxRate: number | null;
    history: {
      payrollId: number;
      period: string;
      periodStart: string;
      basePayRate: number;
      currency: string | null;
      basePayRateUsd: number;
    }[];
  };
  payrollHistory: {
    payrollId: number;
    period: string;
    periodStart: string;
    periodEnd: string;
    year: number;
    grossUsd: number;
    regularPayUsd: number;
    bonusesUsd: number;
    reimbursementsUsd: number;
    deductionsUsd: number;
    hours: number;
  }[];
  payrollSummary: {
    periods: number;
    totalGrossUsd: number;
    avgGrossUsd: number;
    lastGrossUsd: number;
  };
  expenses: {
    count: number;
    totalUsd: number;
    avgUsd: number;
    byMonth: { month: string; count: number; totalUsd: number }[];
    byCategory: { category: string; count: number; totalUsd: number }[];
    recent: {
      id: number;
      date: string;
      category: string;
      amount: number;
      currency: string;
      amountUsd: number;
    }[];
  };
  paystubs: {
    id: number;
    periodStart: string;
    periodEnd: string;
    payDate: string | null;
    status: number;
    currency: string;
    totalGross: number;
    totalDeductions: number;
    totalNet: number;
  }[];
  monthlyReviewCount: number;
}

export interface ExpensesReport {
  asOf: string;
  filters: { months: number; client: string | null; category: string | null };
  range: { start: string; end: string };
  totals: {
    count: number;
    totalUsd: number;
    avgPerExpenseUsd: number;
    avgPerMonthUsd: number;
    employees: number;
    months: number;
  };
  byMonth: { month: string; count: number; totalUsd: number }[];
  byCategory: { category: string; count: number; totalUsd: number; sharePct: number }[];
  byClient: { client: string; count: number; totalUsd: number; sharePct: number }[];
  byDivision: { division: string; count: number; totalUsd: number; sharePct: number }[];
  monthCategorySeries: { month: string; category: string; count: number; totalUsd: number }[];
  topSpenders: {
    userId: number;
    name: string;
    client: string | null;
    count: number;
    totalUsd: number;
  }[];
}

export interface PayrollStats {
  asOf: string;
  filters: { periods: number; division: string | null; client: string | null };
  totals: {
    periods: number;
    grossTotalUsd: number;
    avgPerPeriodUsd: number;
    latestPeriodUsd: number;
    previousPeriodUsd: number;
    changePct: number;
    peakHeadcount: number;
  };
  series: {
    payrollId: number;
    period: string;
    periodStart: string;
    periodEnd: string;
    year: number;
    grossUsd: number;
    regularPayUsd: number;
    bonusesUsd: number;
    reimbursementsUsd: number;
    deductionsUsd: number;
    headcount: number;
    avgCostPerPersonUsd: number;
    byCurrency: { currency: string; amountUsd: number; headcount: number }[];
    byDivision: { division: string; amountUsd: number; headcount: number }[];
  }[];
  byDivision: { division: string; amountUsd: number; headcount: number; sharePct: number }[];
  byCurrency: { currency: string; amountUsd: number; headcount: number; sharePct: number }[];
  byClient: { client: string; amountUsd: number; headcount: number; sharePct: number }[];
}

export function fetchTeamAssignments(
  ctx: ToolContext,
  params: { client?: string; division?: string; q?: string; limit?: number },
): Promise<TeamAssignments> {
  return payrollFetch<TeamAssignments>(
    `/api/internal/team-assignments${qs(params)}`,
    ctx,
  );
}

export function fetchEmployeeProfile(
  ctx: ToolContext,
  person: string,
  params: { periods?: number } = {},
): Promise<EmployeeProfile> {
  return payrollFetch<EmployeeProfile>(
    `/api/internal/employee/${encodeURIComponent(person)}${qs(params)}`,
    ctx,
  );
}

export function fetchExpensesReport(
  ctx: ToolContext,
  params: { months?: number; client?: string; category?: string },
): Promise<ExpensesReport> {
  return payrollFetch<ExpensesReport>(`/api/internal/expenses${qs(params)}`, ctx);
}

export function fetchPayrollStats(
  ctx: ToolContext,
  params: { periods?: number; division?: string; client?: string },
): Promise<PayrollStats> {
  return payrollFetch<PayrollStats>(
    `/api/internal/payroll-stats${qs(params)}`,
    ctx,
  );
}
