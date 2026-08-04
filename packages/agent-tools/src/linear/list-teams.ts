import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
    }),
  ),
});

const QUERY = `
  query Teams {
    teams(first: 100) {
      nodes {
        id
        key
        name
        description
      }
    }
  }
`;

export const listTeams = registerTool({
  id: 'linear.list_teams',
  description:
    'List the Linear teams in the workspace (id, key, name, description). Use the team id to scope issue, cycle, and stats queries.',
  inputSchema: z.object({}),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (_input, ctx) => {
    type R = {
      teams: {
        nodes: Array<{ id: string; key: string; name: string; description: string | null }>;
      };
    };
    const data = await linearFetch<R>(ctx, QUERY);
    return {
      teams: data.teams.nodes.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        description: t.description ?? null,
      })),
    };
  },
});
