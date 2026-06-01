import { z } from 'zod';
import { logger } from '@zipdev/core';
import { registerTool, getTool, runTool } from '../registry.js';
import type { ToolContext } from '../types.js';

const ROLE_KEYWORDS: Record<string, string[]> = {
  frontend:  ['react','vue','angular','svelte','css','html','tailwind','next','nuxt','remix','ui','frontend','front-end','front end'],
  backend:   ['node','express','django','rails','spring','laravel','fastapi','postgres','mysql','redis','api','backend','back-end','back end'],
  fullstack: ['fullstack','full-stack','full stack'],
  data:      ['sql','spark','ml','pandas','dbt','airflow','snowflake','bigquery','data engineer','data scientist','analytics'],
  devops:    ['docker','k8s','kubernetes','terraform','ci/cd','github actions','sre','platform','infrastructure','devops'],
  qa:        ['test','qa','cypress','playwright','selenium','jest','quality'],
  pm:        ['scrum','jira','product','roadmap','agile','sprint','pm'],
  designer:  ['figma','sketch','ux','ui design','designer','design system'],
};

const SENIORITY_TO_YEARS: Record<string, number> = { junior: 1, mid: 3, senior: 6, lead: 10 };
const COUNTRY_TO_REGION: Record<string, string> = { MX:'mx', BR:'br', AR:'ar', CO:'co', CL:'cl', PE:'pe' };

function normalizeRole(freeText: string): { role: string; confidence: number } {
  const lower = freeText.toLowerCase();
  const exact = ['frontend','backend','fullstack','data','devops','qa','pm','designer'];
  if (exact.includes(lower)) return { role: lower, confidence: 1.0 };
  const hasFE = ROLE_KEYWORDS['frontend']?.some(k => lower.includes(k)) ?? false;
  const hasBE = ROLE_KEYWORDS['backend']?.some(k => lower.includes(k)) ?? false;
  if (hasFE && hasBE) return { role: 'fullstack', confidence: 0.8 };
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return { role, confidence: 0.75 };
  }
  logger.warn('normalizeRole: no match, defaulting to fullstack', { freeText });
  return { role: 'fullstack', confidence: 0.5 };
}

const SeniorityIn = z.enum(['junior', 'mid', 'senior', 'staff', 'principal']);
const RateSeniority = z.enum(['junior', 'mid', 'senior', 'lead']);

// Map extended seniority values to the rate estimator's supported values
function toRateSeniority(s: z.infer<typeof SeniorityIn>): z.infer<typeof RateSeniority> {
  if (s === 'staff' || s === 'principal') return 'lead';
  return s;
}

const Role = z.object({
  role: z.string(),
  seniority: SeniorityIn,
  qty: z.number().int().min(1).default(1),
  techStack: z.array(z.string()).default([]),
});

export const salesDraftProposal = registerTool({
  id: 'sales.draft_proposal',
  description:
    'End-to-end Sales workflow: given a company (by id OR name) and a list of roles, fetches HubSpot context, calls the rate estimator per role, retrieves matching past proposals from KB, and returns a structured proposal draft (JSON + Markdown).',
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
        monthlyRange: z.object({ min: z.number(), max: z.number() }),
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
    )) as { results: Array<{ id: string; type: string; subject: string | null; createdAt: string }> };

    const rateTool = getTool('rate.estimate');
    if (!rateTool) throw new Error('rate.estimate not available');

    const roleResults = await Promise.all(
      input.roles.map(async (r) => {
        const { role: normalizedRole, confidence } = normalizeRole(r.role);
        const region = COUNTRY_TO_REGION[country?.toUpperCase?.() ?? ''] ?? 'latam';
        const yearsExperience = SENIORITY_TO_YEARS[r.seniority?.toLowerCase() ?? 'mid'] ?? 3;
        const e = (await runTool(
          rateTool,
          {
            role: normalizedRole,
            seniority: toRateSeniority(r.seniority),
            region,
            yearsExperience,
          },
          ctx,
        )) as { monthlyRateUsd: { min: number; max: number }; notes: string };
        return {
          role: r.role,
          seniority: r.seniority,
          qty: r.qty ?? 1,
          techStack: r.techStack ?? [],
          monthlyRange: e.monthlyRateUsd,
          confidence,
        };
      }),
    );

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
    monthlyRange: { min: number; max: number };
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
  lines.push('| Role | Seniority | Qty | Monthly (USD) |');
  lines.push('|---|---|---:|---:|');
  for (const r of p.roles)
    lines.push(
      `| ${r.role} | ${r.seniority} | ${r.qty} | $${r.monthlyRange.min}–$${r.monthlyRange.max} |`,
    );
  lines.push('');
  if (p.activities.length) {
    lines.push('## Recent activity (HubSpot, last 30d)');
    for (const a of p.activities)
      lines.push(`- **${a.type}**${a.subject ? `: ${a.subject}` : ''}`);
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
