import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.string(),
      progress: z.number(),
      targetDate: z.string().nullable(),
    }),
  ),
});

// Roadmap-level view: just enough per project to render a roadmap. Use
// linear.get_project for the full detail (milestones, lead, description).
const QUERY = `
  query Projects {
    projects(first: 100) {
      nodes {
        id
        name
        state
        progress
        targetDate
      }
    }
  }
`;

export const listProjects = registerTool({
  id: 'linear.list_projects',
  description:
    'List Linear projects at the roadmap level: id, name, state, progress (0–1), and targetDate. Use linear.get_project for milestones, lead, and description.',
  inputSchema: z.object({}),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (_input, ctx) => {
    type R = {
      projects: {
        nodes: Array<{
          id: string;
          name: string;
          state: string;
          progress: number;
          targetDate: string | null;
        }>;
      };
    };
    const data = await linearFetch<R>(ctx, QUERY);
    return {
      projects: data.projects.nodes.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        progress: p.progress,
        targetDate: p.targetDate ?? null,
      })),
    };
  },
});
