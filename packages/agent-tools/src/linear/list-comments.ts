import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      createdAt: z.string(),
      author: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
});

const QUERY = `
  query IssueComments($id: String!) {
    issue(id: $id) {
      comments(first: 100) {
        nodes {
          id
          body
          createdAt
          user {
            id
            name
          }
        }
      }
    }
  }
`;

export const listComments = registerTool({
  id: 'linear.list_comments',
  description:
    'List the comments on a Linear issue (by identifier or id): author, body, and createdAt, oldest first.',
  inputSchema: z.object({ issueId: z.string().min(1) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'linear', scopes: ['read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type R = {
      issue: {
        comments: {
          nodes: Array<{
            id: string;
            body: string;
            createdAt: string;
            user: { id: string; name: string } | null;
          }>;
        };
      };
    };
    const data = await linearFetch<R>(ctx, QUERY, { id: input.issueId });
    return {
      comments: data.issue.comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        author: c.user ? { id: c.user.id, name: c.user.name } : null,
      })),
    };
  },
});
