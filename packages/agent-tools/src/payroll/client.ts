import { IntegrationError } from "@zipdev/core";
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
 * Fetch the payroll team overview from the payroll service's internal API.
 * Auth uses a dedicated PAYROLL_API_TOKEN (the payroll INTERNAL_API_TOKEN value);
 * this is a separate service from the rate estimator — do not reuse RATE_ESTIMATOR_*.
 */
export async function fetchTeamOverview(
  ctx: ToolContext,
): Promise<TeamOverview> {
  const base = process.env.PAYROLL_API_URL;
  const token = process.env.PAYROLL_API_TOKEN;
  if (!base) {
    throw new IntegrationError(
      "Payroll integration not configured (PAYROLL_API_URL / PAYROLL_API_TOKEN missing)",
      "payroll",
    );
  }

  const url = `${base}/api/internal/team-overview`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) {
    throw new IntegrationError(
      `Payroll ${r.status}: ${await r.text()}`,
      "payroll",
    );
  }
  return r.json() as Promise<TeamOverview>;
}
