import { z } from 'zod';
import { registerTool } from '../index';
import { fetchReport } from './roster';
import {
  DATASET,
  FIELD,
  OK_STATUS,
  RATE_GLOSSARY,
  type ReportRow,
  computeMargin,
  dateStr,
  failureStatus,
  moneySchema,
  parseMoney,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from './shape';

/**
 * THE GATED ONE.
 *
 * Pay and bill rates for many people in a single call. That is precisely the
 * export shape the security policy exists to watch: it is declared `alwaysBulk`
 * with `financial` sensitivity in security/policy.ts, which means it asks a
 * human first and is refused outright when a schedule runs it with nobody
 * watching.
 *
 * It is a real business need — margin reviews and cost-per-client questions
 * cannot be answered one employee at a time — so it exists rather than being
 * left as a gap somebody works around by exporting a spreadsheet by hand. But
 * it asks.
 */

const MAX_ROWS = 400;

const lineSchema = z.object({
  name: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /** BambooHR's "department" — at Zipdev, the client the person is placed with. */
  client: z.string().nullable(),
  division: z.string().nullable(),
  payRate: moneySchema,
  payFrequency: z.string().nullable(),
  billRate: moneySchema,
  billRateEffectiveDate: z.string().nullable(),
  grossMargin: moneySchema,
  marginPercent: z.number().nullable(),
});

const REPORT_FIELDS = [
  'id',
  'displayName',
  'jobTitle',
  'department',
  'division',
  'status',
  'payRate',
  'payPeriod',
  'payFrequency',
  FIELD.billRate,
  FIELD.billRateEffectiveDate,
];

export const bambooCompensationReport = registerTool({
  id: 'bamboo.compensation_report',
  description:
    'Pull pay rates AND bill rates for a whole group of people at once from BambooHR — everyone on a client, everyone in a division, or the entire active roster — with the margin between the two worked out per person and in total. This is a bulk compensation export: it needs a person to approve it before it runs, and it will not run unattended on a schedule. For one individual, use the employee lookup instead.',
  inputSchema: z.object({
    client: z
      .string()
      .max(120)
      .optional()
      .describe('Limit to one client or project, e.g. "Momentive Software"'),
    division: z.string().max(120).optional().describe('Limit to one division, e.g. "Tech"'),
    status: z.enum(['active', 'inactive', 'any']).default('active'),
    onlyMissingBillRate: z
      .boolean()
      .default(false)
      .describe('Show only people who have no bill rate recorded — useful for finding gaps'),
    limit: z.number().int().min(1).max(MAX_ROWS).default(MAX_ROWS),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    lines: z.array(lineSchema),
    totalPeople: z.number(),
    /** Totals are only summed inside a single currency; each is reported separately. */
    totalsByCurrency: z.array(
      z.object({
        currency: z.string(),
        people: z.number(),
        totalPay: z.number(),
        totalBill: z.number(),
        totalMargin: z.number(),
        marginPercent: z.number().nullable(),
      }),
    ),
    peopleWithoutBillRate: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.compensation),
      lines: [] as z.infer<typeof lineSchema>[],
      totalPeople: 0,
      totalsByCurrency: [] as Array<{
        currency: string;
        people: number;
        totalPay: number;
        totalBill: number;
        totalMargin: number;
        marginPercent: number | null;
      }>,
      peopleWithoutBillRate: 0,
      guidance: '',
    };

    const res = await fetchReport(ctx, REPORT_FIELDS);
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const wantStatus = input.status ?? 'active';
    const rows = res.data.filter((row: ReportRow) => {
      const status = str(row.status);
      if (wantStatus === 'active' && status !== 'Active') return false;
      if (wantStatus === 'inactive' && status === 'Active') return false;
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

    const all = rows.map((row) => {
      const payRate = parseMoney(row.payRate);
      const billRate = parseMoney(row.customBillRate);
      return {
        name: str(row.displayName),
        jobTitle: str(row.jobTitle),
        client: str(row.department),
        division: str(row.division),
        payRate,
        payFrequency: str(row.payFrequency) ?? str(row.payPeriod),
        billRate,
        billRateEffectiveDate: dateStr(row.customBillRateEffectiveDate),
        ...computeMargin(payRate, billRate),
      };
    });

    const missing = all.filter((l) => l.billRate.amount === null).length;
    const selected = input.onlyMissingBillRate
      ? all.filter((l) => l.billRate.amount === null)
      : all;
    const lines = selected.slice(0, input.limit ?? MAX_ROWS);

    // Summing MXN and USD into one number would be a fabricated total, so each
    // currency is reported on its own and rows with no rate are simply absent.
    const buckets = new Map<string, { people: number; pay: number; bill: number }>();
    for (const l of selected) {
      const currency = l.billRate.currency ?? l.payRate.currency;
      if (!currency) continue;
      if (l.payRate.currency && l.billRate.currency && l.payRate.currency !== l.billRate.currency) {
        continue;
      }
      const b = buckets.get(currency) ?? { people: 0, pay: 0, bill: 0 };
      b.people += 1;
      b.pay += l.payRate.amount ?? 0;
      b.bill += l.billRate.amount ?? 0;
      buckets.set(currency, b);
    }

    const totalsByCurrency = [...buckets.entries()]
      .map(([currency, b]) => {
        const totalMargin = Math.round((b.bill - b.pay) * 100) / 100;
        return {
          currency,
          people: b.people,
          totalPay: Math.round(b.pay * 100) / 100,
          totalBill: Math.round(b.bill * 100) / 100,
          totalMargin,
          marginPercent: b.bill ? Math.round((totalMargin / b.bill) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.people - a.people);

    const notes = [RATE_GLOSSARY];
    if (missing) {
      notes.push(
        `${missing} of these ${selected.length} people have no bill rate on file, so they are missing from the totals.`,
      );
    }
    notes.push(
      'Pay frequencies differ between people (monthly, twice a month, hourly), so treat the totals as a comparison of recorded rates rather than a monthly cost figure.',
    );
    notes.push('This is compensation for many people at once — share it only with whoever asked.');

    return {
      ...OK_STATUS,
      ...empty,
      lines,
      totalPeople: selected.length,
      totalsByCurrency,
      peopleWithoutBillRate: missing,
      guidance: notes.join(' '),
    };
  },
});
