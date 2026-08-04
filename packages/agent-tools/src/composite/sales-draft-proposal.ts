import { logger } from '@cortex/core';
import { z } from 'zod';
import { getTool, registerTool, runTool } from '../index';
import type { ToolContext } from '../types.js';

const ROLE_KEYWORDS: Record<string, string[]> = {
  frontend: [
    'react',
    'vue',
    'angular',
    'svelte',
    'css',
    'html',
    'tailwind',
    'next',
    'nuxt',
    'remix',
    'ui',
    'frontend',
    'front-end',
    'front end',
  ],
  backend: [
    'node',
    'express',
    'django',
    'rails',
    'spring',
    'laravel',
    'fastapi',
    'postgres',
    'mysql',
    'redis',
    'api',
    'backend',
    'back-end',
    'back end',
  ],
  fullstack: ['fullstack', 'full-stack', 'full stack'],
  data: [
    'sql',
    'spark',
    'ml',
    'pandas',
    'dbt',
    'airflow',
    'snowflake',
    'bigquery',
    'data engineer',
    'data scientist',
    'analytics',
  ],
  devops: [
    'docker',
    'k8s',
    'kubernetes',
    'terraform',
    'ci/cd',
    'github actions',
    'sre',
    'platform',
    'infrastructure',
    'devops',
  ],
  qa: ['test', 'qa', 'cypress', 'playwright', 'selenium', 'jest', 'quality'],
  pm: ['scrum', 'jira', 'product', 'roadmap', 'agile', 'sprint', 'pm'],
  designer: ['figma', 'sketch', 'ux', 'ui design', 'designer', 'design system'],
};

function normalizeRole(freeText: string): { role: string; confidence: number } {
  const lower = freeText.toLowerCase();
  const exact = ['frontend', 'backend', 'fullstack', 'data', 'devops', 'qa', 'pm', 'designer'];
  if (exact.includes(lower)) return { role: lower, confidence: 1.0 };
  const hasFE = ROLE_KEYWORDS['frontend']?.some((k) => lower.includes(k)) ?? false;
  const hasBE = ROLE_KEYWORDS['backend']?.some((k) => lower.includes(k)) ?? false;
  if (hasFE && hasBE) return { role: 'fullstack', confidence: 0.8 };
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return { role, confidence: 0.75 };
  }
  logger.warn('normalizeRole: no match, defaulting to fullstack', { freeText });
  return { role: 'fullstack', confidence: 0.5 };
}

const SeniorityIn = z.enum(['junior', 'mid', 'senior', 'staff', 'principal']);

const Role = z.object({
  role: z.string(),
  seniority: SeniorityIn,
  qty: z.number().int().min(1).default(1),
  techStack: z.array(z.string()).default([]),
});

export const salesDraftProposal = registerTool({
  id: 'sales.draft_proposal',
  description:
    'End-to-end Sales workflow: given a company (by id OR name) and a list of roles, fetches HubSpot context, retrieves matching past proposals from Brain Knowledge, and returns a structured proposal draft (JSON + Markdown). ' +
    'It does NOT price the roles — the rate estimator was retired, so the draft leaves the commercial numbers blank on purpose. Pull the figures from comparable past proposals in Brain Knowledge, or ask the user, and never invent a rate.',
  inputSchema: z
    .object({
      companyId: z.string().optional(),
      companyName: z.string().optional(),
      roles: z.array(Role).min(1),
      notes: z.string().optional(),
    })
    .refine((v) => v.companyId || v.companyName, { message: 'companyId or companyName required' }),
  outputSchema: z.object({
    company: z.object({
      id: z.string(),
      name: z.string().nullable(),
      industry: z.string().nullable(),
      country: z.string().nullable(),
    }),
    roles: z.array(
      z.object({
        role: z.string(),
        seniority: z.string(),
        qty: z.number(),
        techStack: z.array(z.string()),
        confidence: z.number(),
      }),
    ),
    recentActivity: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        subject: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    similarCases: z.array(
      z.object({ title: z.string(), chunkIndex: z.number(), excerpt: z.string() }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    let companyId = input.companyId;
    let companyName = input.companyName ?? null;
    let industry: string | null = null;
    let country: string | null = null;

    if (!companyId && companyName) {
      const searchCompaniesTool = getTool('hubspot.search_companies');
      if (!searchCompaniesTool) throw new Error('hubspot.search_companies not available');
      const r = (await runTool(searchCompaniesTool, { query: companyName, limit: 1 }, ctx)) as {
        results: Array<{
          id: string;
          name: string | null;
          industry: string | null;
          country: string | null;
        }>;
      };
      if (!r.results.length) throw new Error(`No HubSpot company matches "${companyName}"`);
      companyId = r.results[0]!.id;
      companyName = r.results[0]!.name;
      industry = r.results[0]!.industry;
      country = r.results[0]!.country;
    } else if (companyId) {
      const getCompanyTool = getTool('hubspot.get_company');
      if (!getCompanyTool) throw new Error('hubspot.get_company not available');
      const c = (await runTool(getCompanyTool, { id: companyId }, ctx)) as {
        id: string;
        name: string | null;
        industry: string | null;
        country: string | null;
      };
      companyName = c.name;
      industry = c.industry;
      country = c.country;
    }

    const listActivitiesTool = getTool('hubspot.list_recent_activities');
    if (!listActivitiesTool) throw new Error('hubspot.list_recent_activities not available');
    const activities = (await runTool(
      listActivitiesTool,
      { companyId: companyId!, days: 30, limit: 5 },
      ctx,
    )) as {
      results: Array<{ id: string; type: string; subject: string | null; createdAt: string }>;
    };

    // Roles are normalised and echoed back, but NOT priced. The rate estimator
    // this step used to call was retired with the rest of the `rate.*` family,
    // and a proposal that quietly ships a made-up number is worse than one that
    // leaves the cell empty — so the pricing column is left for a human, with
    // comparable past proposals from Brain Knowledge right underneath it.
    const roleResults = input.roles.map((r) => ({
      role: r.role,
      seniority: r.seniority,
      qty: r.qty ?? 1,
      techStack: r.techStack ?? [],
      confidence: normalizeRole(r.role).confidence,
    }));

    const kbQuery = `${companyName ?? ''} ${input.roles.map((r) => r.role).join(' ')} proposal`;
    const kbTool = getTool('kb.search');
    let kbHits: Array<{
      documentId: string;
      documentTitle: string;
      chunkIndex: number;
      content: string;
      score: number;
    }> = [];
    if (kbTool) {
      const kb = (await runTool(kbTool, { query: kbQuery, limit: 3 }, ctx)) as {
        hits: typeof kbHits;
      };
      kbHits = kb.hits;
    }

    const md = renderMarkdown({
      companyName,
      industry,
      country,
      roles: roleResults,
      activities: activities.results,
      kb: kbHits,
      notes: input.notes,
    });

    return {
      company: { id: companyId!, name: companyName, industry, country },
      roles: roleResults,
      recentActivity: activities.results,
      similarCases: kbHits.map((h) => ({
        title: h.documentTitle,
        chunkIndex: h.chunkIndex,
        excerpt: h.content.slice(0, 280),
      })),
      markdown: md,
    };
  },
});

function renderMarkdown(p: {
  companyName: string | null;
  industry: string | null;
  country: string | null;
  roles: Array<{
    role: string;
    seniority: string;
    qty: number;
    techStack: string[];
  }>;
  activities: Array<{ type: string; subject: string | null }>;
  kb: Array<{ documentTitle: string; chunkIndex: number; content: string }>;
  notes?: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Proposal — ${p.companyName ?? 'Unknown'}`);
  if (p.industry || p.country)
    lines.push(`*${[p.industry, p.country].filter(Boolean).join(' · ')}*`);
  lines.push('');
  lines.push('## Roles');
  lines.push('| Role | Seniority | Qty | Stack | Monthly (USD) |');
  lines.push('|---|---|---:|---|---:|');
  for (const r of p.roles)
    lines.push(
      `| ${r.role} | ${r.seniority} | ${r.qty} | ${r.techStack.join(', ') || '—'} | _to be priced_ |`,
    );
  lines.push('');
  lines.push(
    '> Pricing is not filled in automatically. Take the figures from a comparable past proposal below, or confirm them with the account owner, before this goes anywhere near a client.',
  );
  lines.push('');
  if (p.activities.length) {
    lines.push('## Recent activity (HubSpot, last 30d)');
    for (const a of p.activities) lines.push(`- **${a.type}**${a.subject ? `: ${a.subject}` : ''}`);
    lines.push('');
  }
  if (p.kb.length) {
    lines.push('## Similar past proposals (KB)');
    p.kb.forEach((h, i) =>
      lines.push(
        `[^${i + 1}]: *${h.documentTitle}* — ${h.content.slice(0, 220).replace(/\n+/g, ' ')}…`,
      ),
    );
    lines.push('');
  }
  if (p.notes) {
    lines.push('## Notes');
    lines.push(p.notes);
    lines.push('');
  }
  return lines.join('\n');
}
