import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  priority: z.number(),
  state: z.object({ name: z.string(), type: z.string() }),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  labels: z.array(z.string()),
  cycle: z.object({ id: z.string(), number: z.number(), name: z.string().nullable() }).nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
});

// Accepts either the human identifier (e.g. "ENG-123") or the UUID — Linear's
// `issue(id:)` resolver accepts both.
const QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      priority
      state {
        name
        type
      }
      assignee {
        id
        name
      }
      labels(first: 50) {
        nodes {
          name
        }
      }
      cycle {
        id
        number
        name
      }
      project {
        id
        name
      }
    }
  }
`;

export const getIssue = registerTool({
  id: 'linear.get_issue',
  description:
    'Get a single Linear issue by identifier (e.g. "ENG-123") or id: title, description, state, assignee, labels, cycle, and project.',
  inputSchema: z.object({ issueId: z.string().min(1) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type R = {
      issue: {
        id: string;
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        priority: number;
        state: { name: string; type: string };
        assignee: { id: string; name: string } | null;
        labels: { nodes: Array<{ name: string }> };
        cycle: { id: string; number: number; name: string | null } | null;
        project: { id: string; name: string } | null;
      };
    };
    const data = await linearFetch<R>(ctx, QUERY, { id: input.issueId });
    const i = data.issue;
    return {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description ?? null,
      url: i.url,
      priority: i.priority,
      state: { name: i.state.name, type: i.state.type },
      assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name } : null,
      labels: i.labels.nodes.map((l) => l.name),
      cycle: i.cycle ? { id: i.cycle.id, number: i.cycle.number, name: i.cycle.name ?? null } : null,
      project: i.project ? { id: i.project.id, name: i.project.name } : null,
    };
  },
});
