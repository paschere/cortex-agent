import { z } from "zod";
import { registerTool } from "../index";
import { fetchEmployeeProfile } from "./client";
import { BAMBOO_BOUNDARY_NOTE, COMP_SENSITIVITY_NOTE } from "./sensitive";

function money(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "N/A";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export const payrollEmployeeProfile = registerTool({
  id: "payroll.employee_profile",
  description:
    "Get the full picture of one person on the team: who they are, which client they are placed with, their job title, when they started and how long they have been here, their current pay rate and how it changed over time, what they were paid in recent payroll periods, and their expense history. " +
    'Use this for "tell me about <person>", "what does <person> do", "who is <person> working for", "how long has <person> been with us", "what is <person> paid", or "how much has <person> expensed". ' +
    "Accepts a name, an email, or the numeric payroll id; if a name matches several people the tool reports the candidates so you can ask which one. " +
    "What it does NOT have: the bill rate charged to the client, the margin on that person, their manager, their client-side contact, or their time-off balance — those live in BambooHR, via bamboo.get_employee. " +
    `${BAMBOO_BOUNDARY_NOTE} ` +
    COMP_SENSITIVITY_NOTE,
  inputSchema: z.object({
    person: z
      .string()
      .min(1)
      .describe("Name, email address, or numeric payroll id of the person"),
    periods: z
      .number()
      .int()
      .min(1)
      .max(24)
      .optional()
      .describe(
        "How many recent completed payroll periods to include (default 8)",
      ),
  }),
  outputSchema: z.object({
    employee: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const data = await fetchEmployeeProfile(ctx, input.person, {
      periods: input.periods,
    });
    const p = data.profile;
    const comp = data.compensation;
    const hist = Array.isArray(data.payrollHistory) ? data.payrollHistory : [];
    const sum = data.payrollSummary;
    const exp = data.expenses;

    const lines: string[] = [];
    lines.push(
      `**${p?.name ?? "Unknown"}** — ${p?.jobTitle ?? "no title on file"}`,
    );
    lines.push("");
    lines.push(
      `- Client: **${p?.client ?? "unassigned"}** | Division: ${p?.division ?? "—"} | ${p?.active ? "active" : "not active"}${p?.newHire ? " · new hire" : ""}`,
    );
    lines.push(
      `- Started: ${p?.hireDate ? p.hireDate.slice(0, 10) : "N/A"}${p?.tenureMonths != null ? ` (${p.tenureMonths} months)` : ""} | Email: ${p?.email ?? "N/A"}`,
    );
    if (comp) {
      const local =
        comp.currentPayRate == null
          ? "N/A"
          : `${Math.round(comp.currentPayRate).toLocaleString("en-US")} ${comp.currency ?? ""}`.trim();
      lines.push(
        `- Current rate: **${local}** (${money(comp.currentPayRateUsd)} USD/month)`,
      );
      const ch = Array.isArray(comp.history) ? comp.history : [];
      const first = ch[0];
      const last = ch[ch.length - 1];
      if (ch.length > 1 && first && last) {
        const delta =
          first.basePayRateUsd > 0
            ? Math.round(
                ((last.basePayRateUsd - first.basePayRateUsd) /
                  first.basePayRateUsd) *
                  100,
              )
            : 0;
        lines.push(
          `- Rate history: ${money(first.basePayRateUsd)} → ${money(last.basePayRateUsd)} USD over ${ch.length} periods (${delta >= 0 ? "+" : ""}${delta}%)`,
        );
      }
    }
    if (sum) {
      lines.push(
        `- Payroll: **${money(sum.totalGrossUsd)}** USD over ${sum.periods} periods (avg ${money(sum.avgGrossUsd)}, last ${money(sum.lastGrossUsd)})`,
      );
    }
    if (exp) {
      lines.push(
        `- Expenses: ${exp.count} submitted, **${money(exp.totalUsd)}** USD total (avg ${money(exp.avgUsd)})`,
      );
    }

    if (hist.length) {
      lines.push("");
      lines.push("**Recent payroll periods (oldest → newest):**");
      lines.push("| Period | Gross USD | Regular | Bonuses | Reimb. | Hours |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const h of hist) {
        lines.push(
          `| ${h.period} | ${money(h.grossUsd)} | ${money(h.regularPayUsd)} | ${money(h.bonusesUsd)} | ${money(h.reimbursementsUsd)} | ${h.hours ?? 0} |`,
        );
      }
    }

    const cats =
      exp && Array.isArray(exp.byCategory) ? exp.byCategory.slice(0, 5) : [];
    if (cats.length) {
      lines.push("");
      lines.push(
        `**Expenses by category:** ${cats.map((c) => `${c.category} ${money(c.totalUsd)} (${c.count})`).join(" · ")}`,
      );
    }

    if (
      typeof data.monthlyReviewCount === "number" &&
      data.monthlyReviewCount > 0
    ) {
      lines.push("");
      lines.push(
        `_${data.monthlyReviewCount} monthly client reviews on file._`,
      );
    }

    lines.push("");
    lines.push(
      "_Compensation figures are confidential — share only with the person asking, never externally without explicit confirmation._",
    );

    return { employee: data, markdown: lines.join("\n") };
  },
});
