import { z } from 'zod';
import { registerTool } from '../index';
import { internalFetch, matcherFetch, qs } from './client';
import {
  type ToolMeta,
  buildMeta,
  metaFromServer,
  metaSchema,
  provenanceFooter,
  requisitionFromLegacyJob,
} from './shape';

const MAX_LIMIT = 50;

function n(v: unknown): string {
  return typeof v === 'number' ? String(v) : '—';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(reqs: any[], meta: ToolMeta): string {
  if (reqs.length === 0) return ['No requisitions matched.', '', provenanceFooter(meta)].join('\n');

  const lines: string[] = [];
  lines.push(`**${reqs.length} requisition(s)**`);
  lines.push('');
  lines.push(
    '| Req | Client | Status | Days open | Candidates (active/total) | Presented | Last activity | Owner |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of reqs) {
    const client = r.client ?? '_unlinked_';
    const owner = r.owner?.recruiter?.name ?? r.owner?.sourcer?.name ?? '—';
    const activity = typeof r.lastActivityAt === 'string' ? r.lastActivityAt.slice(0, 10) : '—';
    lines.push(
      `| ${r.title} | ${client} | ${r.status ?? '_not set_'} | ${n(r.daysOpen)} | ${n(r.candidates?.active)}/${n(r.candidates?.total)} | ${n(r.candidates?.presentedToClient)} | ${activity} | ${owner} |`,
    );
  }
  lines.push('');
  lines.push(provenanceFooter(meta));
  return lines.join('\n');
}

export const listRequisitions = registerTool({
  id: 'recruit.list_requisitions',
  description:
    'START HERE for any question about open roles/requisitions — it is the cheap call. Returns one compact row per requisition: title, client, pipeline status, days open, candidate count with stage breakdown, candidates presented to the client, last activity date, assigned recruiter/sourcer, and a one-line summary of the role. ' +
    'It never returns full job descriptions — use recruit.get_requisition for those, and only when the exact wording matters. ' +
    'This reads the matcher service, which syncs FROM Workable and can therefore lag it. workable.list_jobs is the same roles straight from the ATS, with less detail; go there when the question is what Workable says right now, or when another workable.* tool needs a shortcode. If the two disagree about a role, report both and name the sync time — do not reconcile them yourself. ' +
    'Capped at 50 per call (default 15): check meta.truncated and meta.totalAvailable and page with offset rather than assuming you saw everything. ' +
    'Filters: status ("open", "closed", or an exact pipeline status such as OPEN / ON_HOLD / KOC / CLOSED_WON), companyId, ownerId (recruiter or sourcer), search (title/location/client), includeArchived. ' +
    'PROVENANCE: every row carries `source` (Workable ATS vs matcher service DB, with syncedAt/lastUpdatedAt) and `links` to the matcher and to Workable. When you report findings, cite the system and the freshness ("from Workable, synced 2 hours ago") and never present AI-derived scores as ATS data. ' +
    'Relay meta.dataQuality when it matters — in particular, most requisitions have no client linked, so `client` is null instead of a misleading placeholder name.',
  inputSchema: z.object({
    status: z.string().optional(),
    companyId: z.string().optional(),
    ownerId: z.string().optional(),
    search: z.string().optional(),
    includeArchived: z.boolean().default(false),
    sort: z.enum(['lastActivity', 'daysOpen', 'candidates', 'title']).default('lastActivity'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(15),
    offset: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    requisitions: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    // zod `.default()` is applied at parse time, so the handler's input type
    // still marks these optional — pin them once here.
    const limit = input.limit ?? 15;
    const offset = input.offset ?? 0;
    const query = qs({
      status: input.status,
      companyId: input.companyId,
      ownerId: input.ownerId,
      search: input.search,
      includeArchived: input.includeArchived,
      sort: input.sort,
      limit,
      offset,
    });

    const lean = await internalFetch<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requisitions: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any;
    }>(`/api/internal/recruit/requisitions${query}`);

    if (lean.available) {
      const meta = metaFromServer(lean.data.meta, '/api/internal/recruit/requisitions');
      return {
        requisitions: lean.data.requisitions,
        meta,
        markdown: renderMarkdown(lean.data.requisitions, meta),
      };
    }

    // Fallback: the fat public list. It has no server-side filtering, paging or
    // field selection, so all of that happens here — the model still only sees
    // the lean projection, it just costs a ~300 KB fetch to build it.
    const data = await matcherFetch('/api/jobs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let jobs: any[] = Array.isArray(data) ? data : (data?.jobs ?? []);
    if (!input.includeArchived) jobs = jobs.filter((j) => !j?.archived);
    if (input.companyId) jobs = jobs.filter((j) => j?.companyId === input.companyId);
    if (input.ownerId) {
      jobs = jobs.filter((j) => j?.recruiterId === input.ownerId || j?.sourcerId === input.ownerId);
    }
    if (input.search) {
      const s = input.search.toLowerCase();
      jobs = jobs.filter((j) =>
        [j?.title, j?.location, j?.company].some((v) =>
          String(v ?? '')
            .toLowerCase()
            .includes(s),
        ),
      );
    }
    // The legacy endpoint hardcodes status "Active" on every job, so only the
    // "open"/"active" shorthand can be honoured here at all.
    if (input.status) {
      const s = input.status.toLowerCase();
      if (s !== 'open' && s !== 'active') jobs = [];
    }

    const totalAvailable = jobs.length;
    const page = jobs.slice(offset, offset + limit).map(requisitionFromLegacyJob);
    const unlinked = page.filter((r) => r.clientAttribution === 'unlinked').length;

    const meta = buildMeta({
      endpoint: '/api/jobs',
      degraded: true,
      degradedReason: lean.reason,
      totalAvailable,
      returned: page.length,
      limit,
      offset,
      truncated: offset + page.length < totalAvailable,
      sort: input.sort,
      provenance: {
        'title, location, summary, skills.required': 'Workable ATS, imported into the matcher',
        'client, owner': 'Matcher service DB',
        'candidates.*': 'Matcher service DB — counts as reported by /api/jobs',
      },
      dataQuality: [
        'Pipeline status is unavailable on this endpoint (it reports every job as "Active"), so `status` is null and the placeholder is exposed as `atsStatus`.',
        ...(unlinked
          ? [
              `Client attribution is incomplete: ${unlinked} of ${page.length} returned requisitions have no company linked, so their client is null. Do not report them as the company's own roles.`,
            ]
          : []),
      ],
    });

    return { requisitions: page, meta, markdown: renderMarkdown(page, meta) };
  },
});
