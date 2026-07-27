import { z } from 'zod';
import { registerTool } from '../index';

/** Growth pilot: review queue over growth_signals (see 0029_growth_signals.sql). */

const SignalRow = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  url: z.string(),
  source: z.string(),
  summary: z.string().nullable(),
  region: z.string().nullable(),
  status: z.string(),
  contactName: z.string().nullable(),
  contactTitle: z.string().nullable(),
  contactPath: z.string().nullable(),
  contactConfidence: z.string().nullable(),
  createdAt: z.string(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSignal(r: Record<string, any>): z.infer<typeof SignalRow> {
  return {
    id: r.id,
    company: r.company,
    roleTitle: r.role_title,
    url: r.url,
    source: r.source,
    summary: r.summary ?? null,
    region: r.region ?? null,
    status: r.status,
    contactName: r.contact_name ?? null,
    contactTitle: r.contact_title ?? null,
    contactPath: r.contact_path ?? null,
    contactConfidence: r.contact_confidence ?? null,
    createdAt: r.created_at,
  };
}

export const growthListSignals = registerTool({
  id: 'growth.list_signals',
  description:
    'List stored growth signals (job-post leads) filtered by status: "new" (awaiting review), "qualified" (Mikey-approved targets), "rejected", or "contacted". Sorted newest first. Use sinceDays to scope to the current pilot week.',
  inputSchema: z.object({
    status: z.enum(['new', 'qualified', 'rejected', 'contacted', 'all']).default('new'),
    sinceDays: z.number().int().min(1).max(90).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  outputSchema: z.object({
    signals: z.array(SignalRow),
    countsByStatus: z.record(z.number()),
  }),
  handler: async (input, ctx) => {
    let q = ctx.db
      .from('growth_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(input.limit ?? 30);
    if (input.status !== 'all') q = q.eq('status', input.status);
    if (input.sinceDays) {
      q = q.gte('created_at', new Date(Date.now() - input.sinceDays * 86_400_000).toISOString());
    }
    const { data, error } = await q;
    if (error) throw new Error(`growth_signals query failed: ${error.message}`);

    const { data: all } = await ctx.db.from('growth_signals').select('status');
    const countsByStatus: Record<string, number> = {};
    for (const r of all ?? []) {
      countsByStatus[r.status as string] = (countsByStatus[r.status as string] ?? 0) + 1;
    }

    return { signals: (data ?? []).map(toSignal), countsByStatus };
  },
});

export const growthUpdateSignal = registerTool({
  id: 'growth.update_signal',
  description:
    'Update a growth signal after human review: set status (qualified / rejected / contacted) and optionally record the identified contact (name, title, email or contact path, and whether it was found or pattern-inferred).',
  inputSchema: z.object({
    signalId: z.string().uuid(),
    status: z.enum(['new', 'qualified', 'rejected', 'contacted']).optional(),
    contactName: z.string().optional(),
    contactTitle: z.string().optional(),
    contactPath: z.string().optional(),
    contactConfidence: z.enum(['found', 'inferred', 'unknown']).optional(),
  }),
  outputSchema: z.object({ signal: SignalRow }),
  handler: async (input, ctx) => {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: now };
    if (input.status) {
      patch.status = input.status;
      // A status change is a judgement, so it is attributed. Filling in only a
      // contact is not, which is why this sits inside the status branch: the
      // review page shows "Qualified by <name>", and that must stay true.
      patch.reviewed_by = ctx.userId;
      patch.reviewed_at = now;
    }
    if (input.contactName !== undefined) patch.contact_name = input.contactName;
    if (input.contactTitle !== undefined) patch.contact_title = input.contactTitle;
    if (input.contactPath !== undefined) patch.contact_path = input.contactPath;
    if (input.contactConfidence !== undefined) patch.contact_confidence = input.contactConfidence;

    const { data, error } = await ctx.db
      .from('growth_signals')
      .update(patch)
      .eq('id', input.signalId)
      .select('*')
      .single();
    if (error || !data) throw new Error(`Signal not found: ${input.signalId}`);
    return { signal: toSignal(data) };
  },
});
