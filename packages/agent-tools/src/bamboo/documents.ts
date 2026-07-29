import { z } from 'zod';
import { registerTool } from '../index';
import { bambooFetch } from './client';
import { resolveEmployee } from './roster';
import {
  DATASET,
  OK_STATUS,
  failureStatus,
  isPaystubCategory,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from './shape';

/**
 * What documents a person has on file — LISTING ONLY.
 *
 * BambooHR's file API also uploads, downloads and deletes, and the payroll app
 * uses all three. None of them are exposed here and none should be: a chat
 * agent that can delete somebody's signed contract, or stream their payslip
 * into a conversation, is a liability rather than a feature. This tool answers
 * "has she signed the NDA?" and "is April's payslip uploaded?" — the questions
 * people actually ask — and stops there.
 *
 * File CONTENT is never fetched, so nothing inside a document reaches the
 * model. Only the name, category, size and dates.
 */

interface RawFile {
  id?: number | string;
  name?: string;
  originalFileName?: string;
  size?: number;
  dateCreated?: string;
  createdBy?: string;
  shareWithEmployee?: string;
}

interface RawCategory {
  id?: number | string;
  name?: string;
  files?: RawFile[];
}

interface RawFilesView {
  categories?: RawCategory[];
}

const documentSchema = z.object({
  name: z.string().nullable(),
  category: z.string().nullable(),
  uploadedOn: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  sizeKb: z.number().nullable(),
  /** True when the document is a payslip, from the payment-receipt categories. */
  isPayslip: z.boolean(),
  visibleToEmployee: z.boolean(),
});

const MAX_FILES = 200;

export const bambooListDocuments = registerTool({
  id: 'bamboo.list_documents',
  description:
    'List the documents held against one person in BambooHR — contracts, signed policies, ID documents, payslips and anything else on file — grouped by category, with when each was uploaded and by whom. Answers "has he signed the contract?" or "is her April payslip there?". It lists what exists and never opens, downloads, uploads or deletes anything, so the contents of a document never leave BambooHR.',
  inputSchema: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().max(160).optional(),
      category: z
        .string()
        .max(80)
        .optional()
        .describe('Only this category, e.g. "Payment Receipts", "Contracts"'),
      search: z.string().max(80).optional().describe('Match part of a document name'),
      payslipsOnly: z.boolean().default(false).describe('Only payslips / payment receipts'),
      limit: z.number().int().min(1).max(MAX_FILES).default(50),
    })
    .refine((v) => !!(v.name || v.email), { message: 'Give me a name or a work email' }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    employeeName: z.string().nullable(),
    documents: z.array(documentSchema),
    totalDocuments: z.number(),
    categories: z.array(z.object({ name: z.string().nullable(), count: z.number() })),
    candidates: z.array(z.string()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.documents),
      found: false,
      employeeName: null,
      documents: [] as z.infer<typeof documentSchema>[],
      totalDocuments: 0,
      categories: [] as Array<{ name: string | null; count: number }>,
      candidates: [] as string[],
      guidance: '',
    };

    const resolved = await resolveEmployee(ctx, { name: input.name, email: input.email });
    if (!resolved.ok) return { ...empty, ...failureStatus(resolved) };
    const r = resolved.data;
    if (r.kind === 'none') return { ...empty, configured: true, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return { ...empty, configured: true, reason: r.reason, candidates: r.candidates };
    }

    const res = await bambooFetch<RawFilesView>(
      ctx,
      'GET',
      `/employees/${String(r.row.id)}/files/view/`,
    );
    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const rawCategories = res.data?.categories ?? [];
    const all: z.infer<typeof documentSchema>[] = [];
    const counts: Array<{ name: string | null; count: number }> = [];

    for (const c of rawCategories) {
      const categoryName = str(c.name);
      const files = c.files ?? [];
      if (files.length) counts.push({ name: categoryName, count: files.length });
      // BambooHR returns category ids as strings on this endpoint.
      const payslipCategory = isPaystubCategory(Number(c.id));
      for (const f of files) {
        all.push({
          name: str(f.name) ?? str(f.originalFileName),
          category: categoryName,
          uploadedOn: str(f.dateCreated),
          uploadedBy: str(f.createdBy),
          sizeKb: typeof f.size === 'number' ? Math.round(f.size / 1024) : null,
          isPayslip: payslipCategory,
          visibleToEmployee: str(f.shareWithEmployee) === 'yes',
        });
      }
    }

    const filtered = all.filter((d) => {
      if (input.payslipsOnly && !d.isPayslip) return false;
      if (input.category && !d.category?.toLowerCase().includes(input.category.toLowerCase())) {
        return false;
      }
      if (input.search && !d.name?.toLowerCase().includes(input.search.toLowerCase())) return false;
      return true;
    });

    filtered.sort((a, b) => (b.uploadedOn ?? '').localeCompare(a.uploadedOn ?? ''));

    return {
      ...OK_STATUS,
      ...empty,
      found: true,
      employeeName: str(r.row.displayName),
      documents: filtered.slice(0, input.limit ?? 50),
      totalDocuments: filtered.length,
      categories: counts.sort((a, b) => b.count - a.count),
      guidance: !all.length
        ? 'There are no documents on file for this person in BambooHR.'
        : !filtered.length
          ? `They have ${all.length} documents on file, but none match that filter.`
          : `${filtered.length} of their ${all.length} documents match. I can see what exists but not what is inside — opening a document has to happen in BambooHR.`,
    };
  },
});
