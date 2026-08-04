import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  progress: z.number(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  lead: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  milestones: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      targetDate: z.string().nullable(),
      sortOrder: z.number(),
    }),
  ),
});

const QUERY = `
  query Project($id: String!) {
    project(id: $id) {
      id
      name
      description
      state
      progress
      startDate
      targetDate
      lead {
        id
        name
        email
      }
      projectMilestones(first: 100) {
        nodes {
          id
          name
          targetDate
          sortOrder
        }
      }
    }
  }
`;

export const getProject = registerTool({
  id: 'linear.get_project',
  description:
    'Get full detail for a Linear project: description, state, progress, dates, lead, and milestones. Use linear.list_projects to find project ids.',
  inputSchema: z.object({ projectId: z.string().min(1) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type R = {
      project: {
        id: string;
        name: string;
        description: string | null;
        state: string;
        progress: number;
        startDate: string | null;
        targetDate: string | null;
        lead: { id: string; name: string; email: string | null } | null;
        projectMilestones: {
          nodes: Array<{ id: string; name: string; targetDate: string | null; sortOrder: number }>;
        };
      };
    };
    const data = await linearFetch<R>(ctx, QUERY, { id: input.projectId });
    const p = data.project;
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      state: p.state,
      progress: p.progress,
      startDate: p.startDate ?? null,
      targetDate: p.targetDate ?? null,
      lead: p.lead ? { id: p.lead.id, name: p.lead.name, email: p.lead.email ?? null } : null,
      milestones: p.projectMilestones.nodes.map((m) => ({
        id: m.id,
        name: m.name,
        targetDate: m.targetDate ?? null,
        sortOrder: m.sortOrder,
      })),
    };
  },
});
