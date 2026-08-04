import { z } from "zod";
import { registerTool } from "../index";
import { bambooFetch } from "./client";
import { resolveEmployee } from "./roster";
import {
  DATASET,
  OK_STATUS,
  PAYROLL_BOUNDARY_NOTE,
  RATE_GLOSSARY,
  TABLE,
  computeMargin,
  dateStr,
  failureStatus,
  moneySchema,
  parseMoney,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * One person's rate history — every raise and every bill-rate change, in order.
 *
 * BambooHR keeps these in two separate historical tables that nothing joins:
 * `compensation` (what Cortex pays) and the custom `customBillRate1` (what
 * Cortex charges). Answering "when was her last raise, and did we reprice the
 * client?" means reading both and interleaving them by effective date.
 *
 * Only ever one person at a time. A whole-company rate history is the export
 * shape the security policy exists to gate, and `compensation_report` is the
 * tool that does that, with a confirmation attached.
 */

interface RawCompRow {
  startDate?: string | null;
  rate?: unknown;
  type?: string | null;
  reason?: string | null;
  comment?: string | null;
  paidPer?: string | null;
  paySchedule?: string | null;
}

interface RawBillRow {
  customBillRateEffectiveDate?: string | null;
  customBillRate?: unknown;
  customComment?: string | null;
}

const changeSchema = z.object({
  effectiveDate: z.string().nullable(),
  /** 'pay' — what Cortex pays them. 'bill' — what Cortex charges the client. */
  kind: z.enum(["pay", "bill"]),
  rate: moneySchema,
  reason: z.string().nullable(),
  note: z.string().nullable(),
  /** Change against the previous rate of the same kind. */
  changeFromPrevious: moneySchema,
  percentChange: z.number().nullable(),
});

export const bambooCompensationHistory = registerTool({
  id: "bamboo.compensation_history",
  description: [
    "Show one person's rate history from BambooHR: every change to the pay rate Cortex pays them and every change to the bill rate Cortex charges the client for them, in date order, with the reason recorded for each and the size of each change. Use it for questions like when someone last had a raise, how their rate has moved over time, or whether a pay rise was matched by a client reprice. One person at a time. This is the AGREED rate over time; payroll.employee_profile shows what was actually paid out each period, which is a different question and a different system.",
    PAYROLL_BOUNDARY_NOTE,
  ].join(" "),
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
    changes: z.array(changeSchema),
    currentPayRate: moneySchema.nullable(),
    currentBillRate: moneySchema.nullable(),
    currentMarginPercent: z.number().nullable(),
    lastPayRaiseDate: z.string().nullable(),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 12 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.compensationHistory),
      found: false,
      employeeName: null,
      changes: [] as z.infer<typeof changeSchema>[],
      currentPayRate: null,
      currentBillRate: null,
      currentMarginPercent: null,
      lastPayRaiseDate: null,
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
    const name = str(r.row.displayName);

    const [payRes, billRes] = await Promise.all([
      bambooFetch<RawCompRow[]>(
        ctx,
        "GET",
        `/employees/${id}/tables/${TABLE.compensation}`,
      ),
      bambooFetch<RawBillRow[]>(
        ctx,
        "GET",
        `/employees/${id}/tables/${TABLE.billRate}`,
      ),
    ]);
    if (!payRes.ok) return { ...empty, ...failureStatus(payRes) };

    const payRows = Array.isArray(payRes.data) ? payRes.data : [];
    // A missing bill-rate table is not a failure — it means nothing is on file.
    const billRows =
      billRes.ok && Array.isArray(billRes.data) ? billRes.data : [];

    const pay = payRows
      .map((row) => ({
        effectiveDate: dateStr(row.startDate),
        kind: "pay" as const,
        rate: parseMoney(row.rate),
        reason: str(row.reason),
        note: str(row.comment),
      }))
      .filter((c) => c.rate.amount !== null);

    const bill = billRows
      .map((row) => ({
        effectiveDate: dateStr(row.customBillRateEffectiveDate),
        kind: "bill" as const,
        rate: parseMoney(row.customBillRate),
        reason: null,
        note: str(row.customComment),
      }))
      .filter((c) => c.rate.amount !== null);

    const byDate = (
      a: { effectiveDate: string | null },
      b: { effectiveDate: string | null },
    ) => (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? "");

    pay.sort(byDate);
    bill.sort(byDate);

    const withDeltas = <T extends { rate: ReturnType<typeof parseMoney> }>(
      rows: T[],
    ) =>
      rows.map((row, i) => {
        const prev = i > 0 ? rows[i - 1]?.rate : undefined;
        const delta =
          prev && prev.amount !== null && row.rate.amount !== null
            ? Math.round((row.rate.amount - prev.amount) * 100) / 100
            : null;
        const percent =
          delta !== null && prev?.amount
            ? Math.round((delta / prev.amount) * 1000) / 10
            : null;
        return {
          ...row,
          changeFromPrevious:
            delta === null
              ? { amount: null, currency: null, display: null }
              : parseMoney(`${delta} ${row.rate.currency ?? ""}`.trim()),
          percentChange: percent,
        };
      });

    const changes = [...withDeltas(pay), ...withDeltas(bill)].sort(byDate);

    const currentPay = pay.length ? (pay[pay.length - 1]?.rate ?? null) : null;
    const currentBill = bill.length
      ? (bill[bill.length - 1]?.rate ?? null)
      : null;
    const margin =
      currentPay && currentBill
        ? computeMargin(currentPay, currentBill).marginPercent
        : null;

    // "Last raise" means the last time the number went UP, not the last edit —
    // a re-hire or a correction is not a raise.
    const raises = withDeltas(pay).filter(
      (c) =>
        c.changeFromPrevious.amount !== null && c.changeFromPrevious.amount > 0,
    );
    const lastRaise = raises.length
      ? (raises[raises.length - 1]?.effectiveDate ?? null)
      : null;

    const notes = [RATE_GLOSSARY];
    if (!bill.length) {
      notes.push(
        "No bill rate has ever been recorded for this person in BambooHR.",
      );
    }
    if (!pay.length) {
      notes.push(
        "No pay rate history is recorded for this person in BambooHR.",
      );
    }

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: name,
      changes,
      currentPayRate: currentPay,
      currentBillRate: currentBill,
      currentMarginPercent: margin,
      lastPayRaiseDate: lastRaise,
      guidance: notes.join(" "),
    };
  },
});
