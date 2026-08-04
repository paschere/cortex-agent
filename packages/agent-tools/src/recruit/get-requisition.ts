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
  shortSummary,
} from './shape';

/** Cap applied when falling back to the legacy endpoint, which has no `full` flag. */
const DESCRIPTION_CAP = 3_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(r: any, meta: ToolMeta): string {
  const lines: string[] = [];
  lines.push(
    `# ${r.title ?? '(untitled)'}${r.client ? ` — ${r.client}` : ' — _client not linked_'}`,
  );
  const facts: string[] = [];
  facts.push(`status: ${r.status ?? 'not set'}`);
  if (r.daysOpen != null) facts.push(`${r.daysOpen} days open`);
  if (r.seats != null) facts.push(`${r.seats} seat(s)`);
  if (r.location) facts.push(r.location);
  if (r.pod) facts.push(`pod ${r.pod}`);
  lines.push(facts.join(' · '));
  lines.push('');
  const c = r.candidates ?? {};
  lines.push(
    `**Pipeline:** ${c.total ?? 0} candidates — ${c.active ?? 0} active, ${c.hired ?? 0} hired, ${c.rejected ?? 0} rejected, ${c.presentedToClient ?? 0} presented to client.`,
  );
  if (c.byStage && Object.keys(c.byStage).length) {
    lines.push(
      `**By stage:** ${Object.entries(c.byStage)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  }
  const owner = [
    r.owner?.recruiter?.name ? `recruiter ${r.owner.recruiter.name}` : null,
    r.owner?.sourcer?.name ? `sourcer ${r.owner.sourcer.name}` : null,
  ].filter(Boolean);
  if (owner.length) lines.push(`**Owner:** ${owner.join(', ')}`);
  const skills = r.skills?.required ?? r.skills?.declared ?? [];
  if (Array.isArray(skills) && skills.length)
    lines.push(`**Required skills:** ${skills.join(', ')}`);
  if (r.budget)
    lines.push(
      `**Budget:** ${r.budget.min ?? '?'}–${r.budget.max ?? '?'} ${r.budget.currency ?? ''}`,
    );

  if (Array.isArray(r.topCandidates) && r.topCandidates.length) {
    lines.push('');
    lines.push('**Top-scored candidates** (Cortex AI scoring, not an ATS ranking):');
    lines.push('| Candidate | Score | Stage |');
    lines.push('| --- | --- | --- |');
    for (const t of r.topCandidates) {
      lines.push(
        `| ${t.name} | ${t.score != null ? Math.round(t.score) : '—'} | ${t.stage ?? '—'} |`,
      );
    }
  }

  if (r.description) {
    lines.push('');
    lines.push('**Description**');
    lines.push(String(r.description));
    if (r.descriptionTruncated) {
      lines.push(
        `_(truncated from ${r.descriptionChars} characters — re-request with includeFullDescription)_`,
      );
    }
  } else if (r.summary) {
    lines.push('');
    lines.push(r.summary);
  }

  lines.push('');
  lines.push(provenanceFooter(meta));
  return lines.join('\n');
}

export const getRequisition = registerTool({
  id: 'recruit.get_requisition',
  description:
    'Get one requisition in detail by id: pipeline status, client, seats, budget, owner, days open, full stage breakdown, the five top-scored candidates, and the job description. ' +
    'Prefer recruit.list_requisitions first — this call is only worth it when you need the description text, the budget/seat detail, or the top-candidate shortlist for ONE role. ' +
    'The description is truncated to ~3000 characters by default; pass includeFullDescription only when the exact wording matters (job ads run to tens of thousands of characters and will swamp your context). ' +
    'PROVENANCE: `source` states whether the role came from Workable ATS or was created in the matcher service, with syncedAt/lastUpdatedAt, and `links` gives the matcher and Workable URLs. Cite the system and freshness when you report, and label topCandidates[].score as Cortex AI scoring — it is not an ATS field. Relay meta.dataQuality (unlinked client, unset status, truncation) instead of papering over it.',
  inputSchema: z.object({
    id: z.string().min(1),
    includeFullDescription: z.boolean().default(false),
  }),
  outputSchema: z.object({
    requisition: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input) => {
    const path = `/api/internal/recruit/requisitions/${encodeURIComponent(input.id)}${qs({
      full: input.includeFullDescription || undefined,
    })}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lean = await internalFetch<{ requisition: any; meta: any }>(path);

    if (lean.available) {
      const meta = metaFromServer(lean.data.meta, `/api/internal/recruit/requisitions/${input.id}`);
      return {
        requisition: lean.data.requisition,
        meta,
        markdown: renderMarkdown(lean.data.requisition, meta),
      };
    }

    const job = await matcherFetch(`/api/jobs/${encodeURIComponent(input.id)}`);
    const projected = requisitionFromLegacyJob(job);
    const raw = String(job?.description ?? '');
    const truncated = !input.includeFullDescription && raw.length > DESCRIPTION_CAP;
    const requisition = {
      ...projected,
      employmentType: job?.type ?? null,
      salary: job?.salary ?? null,
      requirements: job?.requirements ?? null,
      description: input.includeFullDescription ? raw : raw.slice(0, DESCRIPTION_CAP),
      descriptionTruncated: truncated,
      descriptionChars: raw.length,
      summary: shortSummary(raw).text || null,
      topCandidates: [],
    };

    const meta = buildMeta({
      endpoint: `/api/jobs/${input.id}`,
      degraded: true,
      degradedReason: lean.reason,
      returned: 1,
      truncated: false,
      provenance: {
        'title, location, description, requirements, skills':
          'Workable ATS, imported into the matcher',
        'client, owner, budget': 'Matcher service DB',
        'candidates.*': 'Matcher service DB — counts as reported by /api/jobs',
      },
      dataQuality: [
        'Pipeline status, seats, pod and the per-stage breakdown are not available on this endpoint.',
        ...(projected.clientAttribution === 'unlinked'
          ? [
              'This requisition has no company linked, so `client` is null. The legacy endpoint would have substituted a placeholder name — that is not a client.',
            ]
          : []),
        ...(truncated
          ? [`Description truncated to ${DESCRIPTION_CAP} of ${raw.length} characters.`]
          : []),
      ],
    });

    return { requisition, meta, markdown: renderMarkdown(requisition, meta) };
  },
});
